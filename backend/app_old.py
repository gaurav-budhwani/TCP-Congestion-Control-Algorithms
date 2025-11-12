from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from io import BytesIO
import csv, traceback, heapq, math, time

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}) # cross origin resource sharing

def run_simulation(algorithm='Reno', bw_mbps=7.0, delay_ms=10.0, buffer_size=50, duration=10.0, mss_bytes=1500):
    MSS_BYTES = float(mss_bytes) # maximum segment size 
    dt = 0.01 # timestamp (ms)
    steps = max(1, int(duration / dt)) # discrete steps
    base_rtt = (delay_ms * 2.0) / 1000.0  # base round trip time in seconds (one way delay)
    link_pps = bw_mbps * 1e6 / (8.0 * MSS_BYTES) # links packet per second using bandwidth and MSS

    cwnd = 1.0 # congestion window iniliasation (1 or 2 is the preferred size)
    ssthresh = 40 # for slow start
    phase = 'slow_start'
    inflight = 0.0 # inflight packets at the start
    buffer_current = 0.0 # for tracking

    ack_delay_steps = max(1, int(round(base_rtt / dt))) # steps that would represent one base RTT
    ack_schedule = [0.0] * (ack_delay_steps + 1) # ack schedule using the steps
    full_timer = 0.0 # how long the queue stays full (for simplicity)
    in_fast_recovery = False

    C = 0.4; beta = 0.7; W_max = cwnd; epoch_start = 0.0; K = 0.0; W_tcp = cwnd # for cubic control

    trace = [] # for collecting sampled metrics
    sim_time = 0.0 # simulated time
    for i in range(steps):
        sim_time += dt
        queue_delay = (buffer_current / max(link_pps, 1e-9)) # delay = queue size / service rate
        rtt_sample = base_rtt + queue_delay # rtt (total) = rtt (prop) + rtt (queuing)

        paced_send = (cwnd / max(base_rtt, 1e-9)) * dt # pacing rate = (cwnd / RTT) * gain
        window_left = max(cwnd - inflight, 0.0) # available for transfer
        to_send = min(paced_send, window_left) # send how much now (limit)

        buffer_current += to_send # data in the send buffer
        inflight += to_send # yet to be ack

        if buffer_current > buffer_size:
            dropped = buffer_current - buffer_size
            buffer_current = buffer_size
            inflight = max(inflight - dropped, 0.0)
        else:
            dropped = 0.0

        drained = min(buffer_current, link_pps * dt) # max amount that can be drained in this time step (max is used for actual amount to be calculated)
        buffer_current -= drained # update the buffer level

        if len(ack_schedule) <= ack_delay_steps: # preventing index out of bounds error
            ack_schedule.extend([0.0] * (ack_delay_steps - len(ack_schedule) + 1))
        ack_schedule[ack_delay_steps] += drained

        acked = ack_schedule.pop(0)
        ack_schedule.append(0.0)
        inflight = max(inflight - acked, 0.0)

        throughput = (drained * MSS_BYTES * 8.0) / (dt * 1e6)  # Mbps (packets * bytes / packets * bits/byte) / (time (s) * bits/megabit)

        if buffer_current >= buffer_size * 0.98:
            full_timer += dt
        else:
            full_timer = max(0.0, full_timer - dt)
        timeout_like = (dropped > 0.0) and (full_timer >= base_rtt)
        dupack_like = (dropped > 0.0) and not timeout_like

        if algorithm == 'Reno':
            if timeout_like:
                ssthresh = max(cwnd / 2.0, 2.0) # slow start threshold
                cwnd = ssthresh
                phase = 'congestion_avoidance'
                in_fast_recovery = False
            elif dupack_like:
                if not in_fast_recovery:
                    ssthresh = max(cwnd / 2.0, 2.0)
                    cwnd = ssthresh
                    in_fast_recovery = True
                    phase = 'congestion_avoidance'
            if phase == 'slow_start':
                cwnd += acked # additive increase
                if cwnd >= ssthresh:
                    phase = 'congestion_avoidance'
            else:
                cwnd += (acked / max(cwnd, 1.0))
            if in_fast_recovery and acked > 0 and not dupack_like:
                in_fast_recovery = False

        elif algorithm == 'Cubic': # w(t) = C(t - K)^3 + Wmax, where C is the scaling constant, K is offset time and Wmax is last cwnd before loss.
            if timeout_like or dupack_like:
                W_max = max(cwnd, 1.0) # last cwnd before loss
                cwnd = max(beta * cwnd, 2.0) 
                epoch_start = sim_time 
                K = ((W_max * (1.0 - beta)) / C) ** (1.0 / 3.0) if W_max > 0 else 0.0 # time offset
                W_tcp = cwnd
            t = max(sim_time - epoch_start, 0.0)
            W_cubic_next = C * ((t + base_rtt) - K) ** 3 + W_max # TCP Cubic
            delta = max(W_cubic_next - cwnd, 0.0)
            if cwnd > 0.0:
                cwnd += delta * (acked / cwnd)
            W_tcp += (acked / max(W_tcp, 1.0))
            if cwnd < W_tcp:
                cwnd = W_tcp
            phase = 'cubic'

        else:  # BBR, cwnd  = 2 * (bandwidth * RTT)
            target_cwnd = max(4.0, 2.0 * (bw_mbps / 8.0 * 1e6 / MSS_BYTES) * base_rtt)
            if acked > 0 and cwnd > 0:
                gap = target_cwnd - cwnd
                cwnd += (acked / max(cwnd, 1.0)) * gap
            phase = 'BBR'

        cwnd = max(cwnd, 1.0)
        if i % int(0.1 / dt) == 0:
            trace.append({
                'time': round(sim_time, 3),
                'cwnd': round(cwnd, 4),
                'throughput': round(throughput, 4),
                'buffer': round(buffer_current, 4),
                'inflight': round(inflight, 4),
                'phase': phase
            })
    return trace


# multi flow simulation
def simulate_flows(flows, links, paths, duration=20.0, dt=0.05, mss=1500):
    """trying to produce time series per-lnk queue history
        returns (traces, debug links) based on the flows, links and paths
    """
    # initialize link state
    for lk, l in links.items():
        l.setdefault('bandwidth', 1.0)
        l.setdefault('delay', 15.0)
        l.setdefault('buffer', 20)
        l.setdefault('mss', mss)
        l['bytes_per_sec'] = float(l['bandwidth']) * 1e6 / 8.0
        l['queue'] = 0.0
        l['_queue_history'] = []

    # state per flow
    state = {}
    for f in flows:
        fid = f.get('id') or f"{f.get('src','?')}-{f.get('dst','?')}"
        state[fid] = {'cwnd': 1.0, 'inflight': 0.0, 'throughput_Mbps': 0.0}

    # map flows -> their path links
    flow_to_links = {}
    for f in flows:
        fid = f.get('id') or f"{f.get('src','?')}-{f.get('dst','?')}"
        flow_to_links[fid] = paths.get(fid, []) or []

    # flows on each link
    flows_on_link = {}
    for lk in links:
        flows_on_link[lk] = [fid for fid, path in flow_to_links.items() if lk in path]

    traces = {fid: [] for fid in flow_to_links.keys()}

    t = 0.0
    n_steps = max(1, int(round(duration / dt)))
    for step in range(n_steps + 1):
        # compute per-link available bytes this step
        link_avail_bytes = {lk: links[lk]['bytes_per_sec'] * dt for lk in links}

        # for each flow compute its desired send (fractional pkts) and delivered pkts
        for fid, path_links in flow_to_links.items():
            f_config = next((f for f in flows if (f.get('id') or f"{f.get('src','?')}-{f.get('dst','?')}") == fid), {})
            algo = (f_config.get('algorithm') or 'Reno').lower()

            st = state[fid]

            # want_send in packets = cwnd - inflight
            want_send_pkts = max(0.0, st['cwnd'] - st['inflight'])
            if want_send_pkts <= 0 or len(path_links) == 0:
                delivered_pkts = 0.0
            else:
                # per-link share (fair share among flows on that link)
                per_link_capacity_pkts = []
                for lk in path_links:
                    available_bytes = link_avail_bytes.get(lk, 0.0)
                    num_flows = max(1, len(flows_on_link.get(lk, [])))
                    share_bytes = available_bytes / float(num_flows)
                    link_mss = links[lk].get('mss', mss)
                    per_link_capacity_pkts.append(share_bytes / float(max(1.0, link_mss)))
                # delivered limited by smallest link capacity on path
                delivered_pkts = min(want_send_pkts, min(per_link_capacity_pkts) if per_link_capacity_pkts else 0.0)

                # consume the bytes used on each link proportionally
                used_bytes = delivered_pkts * float(mss)
                for lk in path_links:
                    link_avail_bytes[lk] = max(0.0, link_avail_bytes.get(lk, 0.0) - used_bytes)

            # update inflight and throughput
            st['inflight'] = max(0.0, st['inflight'] + want_send_pkts - delivered_pkts)
            st['throughput_Mbps'] = (delivered_pkts * mss * 8.0) / (dt * 1e6) if dt > 0 else 0.0

            # update cwnd according to very simplified dynamics
            if algo == 'reno':
                if delivered_pkts >= want_send_pkts and want_send_pkts > 0:
                    st['cwnd'] += 0.5 * (delivered_pkts / max(1.0, want_send_pkts))  # gentle increase
                else:
                    st['cwnd'] = max(1.0, st['cwnd'] * 0.9)
            elif algo == 'cubic':
                if delivered_pkts >= want_send_pkts and want_send_pkts > 0:
                    st['cwnd'] += 0.8 * (delivered_pkts / max(1.0, want_send_pkts))
                else:
                    st['cwnd'] = max(1.0, st['cwnd'] * 0.85)
            else:  # bbr-ish
                if path_links:
                    bottleneck_mbps = min(links[lk].get('bandwidth', 1.0) for lk in path_links)
                    total_delay_ms = sum(links[lk].get('delay', 15.0) for lk in path_links)
                    rtt_s = max(0.001, (total_delay_ms * 2) / 1000.0)
                    bdp_bytes = bottleneck_mbps * 1e6 * rtt_s
                    target_pkts = max(1.0, bdp_bytes / float(mss))
                    st['cwnd'] += 0.2 * (target_pkts - st['cwnd'])
                else:
                    st['cwnd'] += 0.1

            st['cwnd'] = max(0.1, st['cwnd'])

            traces[fid].append({
                'time': round(t, 3),
                'cwnd': round(st['cwnd'], 4),
                'throughput': round(st['throughput_Mbps'], 6),
                'buffer': round(0.0, 4)
            })

        # simple per-link queue accounting: compute drained bytes = original capacity - remaining
        for lk in links:
            original = links[lk]['bytes_per_sec'] * dt
            remaining = link_avail_bytes.get(lk, 0.0)
            drained = max(0.0, original - remaining)
            drained_pkts = drained / float(mss)
            # naive queue estimator: queue grows if offered > drained (we approximated fairness)
            # For simple debug, append queue (we do not simulate complicated per-packet queueing)
            links[lk]['queue'] = max(0.0, links[lk].get('queue', 0.0) + 0.0)
            links[lk]['_queue_history'].append(round(links[lk]['queue'], 4))

        t += dt

    # Build debug summary
    debug_links = {}
    for lk, v in links.items():
        debug_links[lk] = {
            'bandwidth': v.get('bandwidth'),
            'delay': v.get('delay'),
            'buffer': v.get('buffer'),
            'mss': v.get('mss'),
            'queue_history': v.get('_queue_history', [])
        }

    return traces, debug_links


# routing and topology
def build_graph_from_topology(topology_name, default_link, flows):
    links = {}
    graph = {}

    def add_link(a, b, params=None):
        key = f"{a}-{b}"
        # store a copy, not the same object
        links[key] = dict(params or default_link)
        graph.setdefault(a, {})[b] = key
        graph.setdefault(b, {})[a] = key

    # discover unique senders & receivers from flows
    senders = []
    receivers = []
    for f in flows:
        s = f.get('src')
        d = f.get('dst')
        if s and s not in senders: senders.append(s)
        if d and d not in receivers: receivers.append(d)

    topo = (topology_name or 'parallel').lower()
    if topo == 'single':
        routers = ['R']
        for s in senders: add_link(s, 'R', default_link)
        for r in receivers: add_link('R', r, default_link)
    elif topo == 'series':
        routers = ['R1', 'R2']
        for s in senders: add_link(s, 'R1', default_link)
        add_link('R1', 'R2', default_link)
        for r in receivers: add_link('R2', r, default_link)
    elif topo == 'parallel':
        routers = ['R1', 'R2']
        for s in senders:
            add_link(s, 'R1', default_link)
            add_link(s, 'R2', default_link)
        for r in routers:
            for rc in receivers: add_link(r, rc, default_link)
    elif topo == 'triangle':
        routers = ['R1', 'R2', 'R3']
        add_link('R1', 'R2', default_link)
        add_link('R2', 'R3', default_link)
        #add_link('R3', 'R1', default_link)
        for s in senders: add_link(s, 'R1', default_link)
        for rc in receivers: add_link('R3', rc, default_link)
    else:
        # fallback parallel
        routers = ['R1', 'R2']
        for s in senders:
            add_link(s, 'R1', default_link)
            add_link(s, 'R2', default_link)
        for r in routers:
            for rc in receivers: add_link(r, rc, default_link)

    return links, graph


def link_cost_factory(links, alpha_delay=1.0, beta_inv_bw=50.0):
    def cost(linkKey):
        lk = links[linkKey]
        delay = float(lk.get('delay', 15.0))
        bw = float(lk.get('bandwidth', 1.0))
        return alpha_delay * delay + beta_inv_bw * (1.0 / max(0.001, bw))
    return cost


def dijkstra(graph, start, goal, cost_fn):
    # standard Dijkstra returning node path (list of nodes) or None
    pq = [(0.0, start, [])]
    best = {}
    while pq:
        c, node, path = heapq.heappop(pq)
        if node == goal:
            return path + [node]
        if node in best and best[node] <= c:
            continue
        best[node] = c
        for nbr, linkKey in graph.get(node, {}).items():
            nc = c + cost_fn(linkKey)
            heapq.heappush(pq, (nc, nbr, path + [node]))
    return None


def nodes_to_linkkeys(nodes_path, graph):
    if not nodes_path or len(nodes_path) < 2:
        return []
    lk = []
    for i in range(len(nodes_path) - 1):
        a = nodes_path[i]; b = nodes_path[i + 1]
        key = graph.get(a, {}).get(b)
        if not key:
            return None
        lk.append(key)
    return lk


# endpoints for frontend to connect to
@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'message': 'backend alive'})


@app.route('/simulate', methods=['POST'])
def simulate():
    try:
        data = request.json or {}
        algo = data.get('algorithm', 'Reno')
        bw = float(data.get('bandwidth', 5))
        delay = float(data.get('delay', 10))
        buffer_size = int(data.get('buffer', 50))
        duration = float(data.get('duration', 10))
        mss = int(data.get('mss', 1500))
    except Exception as e:
        return jsonify({'error': str(e)}), 400
    trace = run_simulation(algo, bw, delay, buffer_size, duration, mss)
    return jsonify({'success': True, 'trace': trace})


@app.route('/simulate_csv', methods=['POST'])
def simulate_csv():
    try:
        data = request.json or {}
        algo = data.get('algorithm', 'Reno')
        bw = float(data.get('bandwidth', 7))
        delay = float(data.get('delay', 10))
        buffer_size = int(data.get('buffer', 50))
        duration = float(data.get('duration', 10))
        mss = int(data.get('mss', 1500))
    except Exception as e:
        return jsonify({'error': str(e)}), 400

    trace = run_simulation(algo, bw, delay, buffer_size, duration, mss)
    output = BytesIO()
    writer = csv.writer(output)
    header = ['time', 'cwnd', 'throughput', 'buffer', 'inflight', 'phase']
    writer.writerow(header)
    for row in trace:
        writer.writerow([row.get(h, '') for h in header])
    csv_bytes = output.getvalue()
    return Response(csv_bytes, mimetype='text/csv',
                    headers={"Content-disposition": f"attachment; filename=trace_{algo}.csv"})


@app.route('/simulate_multi', methods=['POST'])
def simulate_multi():
    try:
        body = request.get_json(force=True)
        topology = body.get('topology', 'parallel')
        link_params = body.get('linkParams', {}) or {}
        flows = body.get('flows', []) or []
        link_overrides = body.get('linkOverrides', {}) or {}
    except Exception as e:
        return jsonify({'success': False, 'error': f'bad request: {e}'}), 400

    try:
        # defaults
        default_link = {
            'bandwidth': float(link_params.get('bandwidth', 5.0)),
            'delay': float(link_params.get('delay', 15.0)),
            'buffer': int(link_params.get('buffer', 20)),
            'mss': int(link_params.get('mss', 1500))
        }
        duration = float(link_params.get('duration', 20.0))
        dt = float(link_params.get('dt', 0.05))

        links, graph = build_graph_from_topology(topology, default_link, flows)

        # apply overrides
        for lk_name, overrides in (link_overrides or {}).items():
            if lk_name in links:
                for k, v in overrides.items():
                    if k in ('bandwidth', 'delay'):
                        links[lk_name][k] = float(v)
                    elif k in ('buffer', 'mss'):
                        links[lk_name][k] = int(v)

        # choose per-flow paths
        cost_fn = link_cost_factory(links)
        paths = {}
        for f in flows:
            fid = f.get('id') or f"{f.get('src','?')}-{f.get('dst','?')}"
            src = f.get('src'); dst = f.get('dst')
            if not src or not dst:
                paths[fid] = []
                continue
            nodes_path = dijkstra(graph, src, dst, cost_fn)
            if not nodes_path:
                paths[fid] = []
            else:
                linkkeys = nodes_to_linkkeys(nodes_path, graph) or []
                paths[fid] = linkkeys

        # simulate_flows returns (traces, debug_links)
        sim_out = simulate_flows(flows=flows, links=links, paths=paths, duration=duration, dt=dt, mss=default_link['mss'])
        if isinstance(sim_out, tuple) and len(sim_out) == 2:
            traces, debug_links = sim_out
        else:
            traces = sim_out
            debug_links = {k: v for k, v in links.items()}

        debug_info = { 'links': debug_links, 'paths': paths, 'graph_nodes': list(graph.keys()) }

        return jsonify({'success': True, 'traces': traces, 'debug': debug_info}), 200

    except Exception as e:
        tb = traceback.format_exc()
        print("simulate_multi ERROR:\n", tb)
        return jsonify({'success': False, 'error': str(e), 'traceback': tb, 'request_body': body}), 500


if __name__ == '__main__':
    #print("Starting backend on http://localhost:5001")
    app.run(host='localhost', port=5001, debug=True)