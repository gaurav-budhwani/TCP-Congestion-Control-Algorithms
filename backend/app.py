from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from io import BytesIO
import csv, traceback, heapq, math, time
import subprocess
import shlex
import os

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})  # cross origin resource sharing

# python simulation
def run_simulation(algorithm='Reno', bw_mbps=7.0, delay_ms=10.0, buffer_size=50, duration=10.0, mss_bytes=1500):
    MSS_BYTES = float(mss_bytes) # maximum segment size
    dt = 0.01 # timestamp (ms)
    steps = max(1, int(duration / dt)) # number of discrete steps
    base_rtt = (delay_ms * 2.0) / 1000.0 # RTT
    link_pps = bw_mbps * 1e6 / (8.0 * MSS_BYTES) # links packet per second using bandwidth and MSS
    
    cwnd = 1.0 # Congestion window
    ssthresh = 40.0 # Slow start threshold 
    buffer_size_int = int(buffer_size) # Buffer size
    
    inflight = 0 # Inflight packets
    buffer_current = 0 # Current buffer 
    
    # ACK schedule now holds integer packet counts
    ack_delay_steps = max(1, int(round(base_rtt / dt))) # steps for one base rtt
    ack_schedule = [0] * (ack_delay_steps + 1) # schedule for ack using the steps
    # Packet credit for pacing (float)
    packet_credit = 0.0

    phase = 'slow_start' 
    full_timer = 0.0
    in_fast_recovery = False
    C = 0.4; beta = 0.7; W_max = cwnd; epoch_start = 0.0; K = 0.0; W_tcp = cwnd # paramters for cubic TCP
    
    # for packets (now integers)
    sent_total = 0 
    delivered_total = 0
    dropped_total = 0
    trace = [] # for collecting sampled metrics
    sim_time = 0.0 # current simulation time
    
    for i in range(steps):
        sim_time += dt # increment 
        queue_delay = (buffer_current / max(link_pps, 1e-9)) 
        rtt_sample = base_rtt + queue_delay 
        current_rtt_steps = max(1, int(round(rtt_sample / dt))) 
        packet_credit += (cwnd / max(base_rtt, 1e-9)) * dt
        
        window_left_int = int(math.floor(cwnd)) - inflight
        wants_to_send_paced_int = int(math.floor(packet_credit))
        
        to_send = max(0, min(wants_to_send_paced_int, window_left_int))
        
        if to_send > 0:
            packet_credit -= to_send # Subtract the whole packets we're sending
            buffer_current += to_send 
            inflight += to_send       
            sent_total += to_send     

        if buffer_current > buffer_size_int:
            dropped = buffer_current - buffer_size_int 
            buffer_current = buffer_size_int           
            inflight = max(0, inflight - dropped)    
            dropped_total += dropped
        else:
            dropped = 0 
        
        drained_float = min(buffer_current, link_pps * dt)
        drained = int(math.floor(drained_float)) 
        
        if drained > 0:
            buffer_current -= drained                  
            delivered_total += drained                 
        
        if len(ack_schedule) <= current_rtt_steps:
            ack_schedule.extend([0] * (current_rtt_steps - len(ack_schedule) + 1))
        ack_schedule[current_rtt_steps] += drained
        
        acked = ack_schedule.pop(0) 
        ack_schedule.append(0)
        
        inflight = max(0, inflight - acked) 
        throughput = (drained * MSS_BYTES * 8.0) / (dt * 1e6) 

        if dropped > 0:
            full_timer += dt
        else:
            full_timer = max(0.0, full_timer - dt)
            
        timeout_like = (dropped > 0) and (full_timer >= rtt_sample) 
        dupack_like = (dropped > 0) and not timeout_like
        
        if algorithm == 'Reno':
            if timeout_like:
                ssthresh = max(cwnd / 2.0, 2.0)
                cwnd = 1.0 
                phase = 'slow_start'
                in_fast_recovery = False
            elif dupack_like:
                if not in_fast_recovery:
                    ssthresh = max(cwnd / 2.0, 2.0)
                    cwnd = ssthresh
                    in_fast_recovery = True
                    phase = 'congestion_avoidance'
            if phase == 'slow_start':
                cwnd += acked 
                if cwnd >= ssthresh:
                    phase = 'congestion_avoidance'
            else:
                cwnd += (acked / max(cwnd, 1.0))
            if in_fast_recovery and acked > 0 and not dupack_like:
                in_fast_recovery = False
        
        elif algorithm == 'Cubic':
            if timeout_like or dupack_like:
                W_max = cwnd
                epoch_start = sim_time
                cwnd = max(cwnd * beta, 2.0)
                ssthresh = cwnd
                K = ((W_max * (1.0 - beta)) / C) ** (1.0 / 3.0) if W_max > 0 else 0.0
                W_tcp = cwnd
            if phase == 'slow_start':
                cwnd += acked
                if cwnd >= ssthresh:
                    phase = 'congestion_avoidance'
            else:
                t = (sim_time + rtt_sample) - epoch_start
                W_cubic = C * (t - K) ** 3 + W_max
                W_tcp += (acked / max(W_tcp, 1.0))
                if W_cubic < W_tcp:
                    cwnd = W_tcp
                else:
                    cwnd_target = W_cubic
                    cwnd_diff = cwnd_target - cwnd
                    cwnd += (cwnd_diff / max(1.0, cwnd)) * acked 
        
        elif algorithm == 'BBR':
            bdp_pkts = (bw_mbps * 1e6 / (8.0 * MSS_BYTES)) * base_rtt
            target_cwnd = max(4.0, 1.0 * bdp_pkts)
            if dropped > 0:
                 cwnd = max(4.0, cwnd * 0.8) 
            else:
                 cwnd += 0.1 * (target_cwnd - cwnd)
        
        cwnd = max(cwnd, 1.0) 
        
        if i % int(0.1 / dt) == 0:
            trace.append({
                'time': round(sim_time, 3),
                'cwnd': round(cwnd, 4),
                'throughput': round(throughput, 4),
                'buffer': buffer_current, 
                'inflight': inflight,     
                'phase': phase,
                'sent': sent_total,        
                'delivered': delivered_total,  
                'dropped': dropped_total       
            })
    return trace

# ns3 simulation (network simulator)
def run_simulation_ns3(algorithm='Reno', bw_mbps=7.0, delay_ms=10.0, buffer_size=50, duration=10.0, mss_bytes=1500):
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.abspath(os.path.join(backend_dir, '..'))
    ns3_dir = os.path.join(base_dir, 'ns3')
    ns3_executable = os.path.join(ns3_dir, 'ns3') 
    
    if not os.path.exists(ns3_executable):
        print(f"ns-3 executable not found at {ns3_executable}")
        print("Please compile your ns-3 project first.")
        raise FileNotFoundError(f"ns-3 executable not found. Did you compile it? Looked for: {ns3_executable}")

    output_csv = os.path.join(ns3_dir, 'trace_flow0.csv')
    
    if os.path.exists(output_csv):
        try:
            os.remove(output_csv)
        except OSError as e:
            print(f"Warning: Could not remove old trace file: {e}")

    run_string = (
        f'scratch/tcp_multi '
        f'--flows={shlex.quote(algorithm)} '
        f'--rate={shlex.quote(str(bw_mbps))}Mbps '
        f'--delay={shlex.quote(str(delay_ms))}ms '
        f'--bufferPkts={shlex.quote(str(int(buffer_size)))} '
        f'--duration={shlex.quote(str(int(duration)))} '
        f'--mss={shlex.quote(str(int(mss_bytes)))}'
    )

    command = [ns3_executable, 'run', run_string]
    print(f"Running ns-3 command: {' '.join(command)}")

    try:
        proc = subprocess.run(
            command,
            cwd=ns3_dir,
            capture_output=True,
            text=True,
            timeout=30,
            check=True
        )
    except subprocess.CalledProcessError as e:
        print("NS-3 EXECUTION FAILED")
        print("STDOUT:", e.stdout)
        print("STDERR:", e.stderr)
        raise Exception("ns-3 simulation failed: " + e.stderr)
    except Exception as e:
        print(f"An unknown error occurred while running ns-3: {e}")
        raise

    if not os.path.exists(output_csv):
        print(f"ns-3 ran but did not create output file: {output_csv}")
        print("STDOUT:", proc.stdout)
        print("STDERR:", proc.stderr)
        raise FileNotFoundError("ns-3 ran but trace_flow0.csv was not created.")

    trace = []
    try:
        with open(output_csv, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                trace.append({
                    'time': float(row['time']),
                    'cwnd': float(row['cwnd_pkts']),
                    'throughput': float(row['throughput_mbps']),
                    'buffer': float(row['buffer_pkts']),
                    'inflight': float(row['inflight_pkts']),
                    'phase': 'ns3',
                    'sent': 0,
                    'delivered': 0,
                    'dropped': 0
                })
    except Exception as e:
        print(f"Error parsing ns-3 output file: {e}")
        raise
        
    print(f"Parsed {len(trace)} data points from ns-3.")
    return trace

# multi flow
def simulate_flows(flows, links, paths, duration=20.0, dt=0.05, mss=1500):
    n_steps = max(1, int(round(duration / dt)))
    for lk, l in links.items():
        l.setdefault('bandwidth', 1.0)
        l.setdefault('delay', 15.0)
        l.setdefault('buffer', 20)
        l.setdefault('mss', mss)
        l['bytes_per_sec'] = float(l['bandwidth']) * 1e6 / 8.0
        l.setdefault('queue_bytes', 0.0)
        l.setdefault('per_flow_queue', {})
        l.setdefault('_queue_history', [])
    flow_to_links = {}
    for f in flows:
        fid = f.get('id') or f"{f.get('src','?')}-{f.get('dst','?')}"
        flow_to_links[fid] = paths.get(fid, []) or []
    state = {}
    for f in flows:
        fid = f.get('id') or f"{f.get('src','?')}-{f.get('dst','?')}"
        path_links = flow_to_links.get(fid, [])
        total_delay_ms = sum(float(links[lk].get('delay', 15.0)) for lk in path_links)
        base_rtt_s = max(0.001, (total_delay_ms * 2) / 1000.0)
        base_rtt_steps = max(1, int(round(base_rtt_s / dt)))
        bottleneck_bw_mbps = 1000.0
        if path_links:
            try:
                bottleneck_bw_mbps = min(float(links[lk]['bandwidth']) for lk in path_links)
            except KeyError as e:
                print(f"Warning: Link key {e} not found for flow {fid}. Defaulting BW.")
                bottleneck_bw_mbps = 1.0

        state[fid] = {
            'cwnd': 1.0, 'inflight': 0.0, 'throughput_Mbps': 0.0,
            'sent': 0.0, 'delivered': 0.0, 'dropped_cum': 0.0,
            'ack_schedule': [0.0] * (n_steps + 500), # Increased buffer
            'base_rtt_s': base_rtt_s, 'base_rtt_steps': base_rtt_steps,
            'bottleneck_bw_mbps': bottleneck_bw_mbps, 'ssthresh': 1e12,
            'phase': 'slow_start', 'in_fast_recovery': False, 'full_timer': 0.0,
            'W_max': 1.0, 'epoch_start': 0.0, 'K': 0.0, 'W_tcp': 1.0,
            'C': 0.4, 'beta': 0.7,
        }
    traces = {fid: [] for fid in flow_to_links.keys()}
    t = 0.0
    for step in range(n_steps + 1):
        t = step * dt
        sent_pkts_map = {}
        for fid, path_links in flow_to_links.items():
            st = state[fid]
            paced_send = (st['cwnd'] / max(st['base_rtt_s'], 1e-9)) * dt
            window_left = max(st['cwnd'] - st['inflight'], 0.0)
            want_send_pkts = min(paced_send, window_left)
            sent_pkts_map[fid] = want_send_pkts
            st['sent'] += want_send_pkts
            offered_bytes = want_send_pkts * float(mss)
            for lk in path_links:
                if lk not in links: continue # path link might not be in graph
                link = links[lk]
                pfq = link.setdefault('per_flow_queue', {})
                pfq[fid] = pfq.get(fid, 0.0) + offered_bytes
                link['queue_bytes'] = sum(pfq.values())
        flow_dropped_this_step = {fid: 0.0 for fid in flow_to_links.keys()}
        drained_pkts_map = {fid: 0.0 for fid in flow_to_links.keys()}
        per_link_drained_by_flow = {}
        per_link_queue_delay = {}
        for lk, link in links.items():
            capacity = link['bytes_per_sec'] * dt
            pfq = link.setdefault('per_flow_queue', {})
            total_present = sum(pfq.values())
            per_link_drained_by_flow[lk] = {}
            link_pps = (link['bandwidth'] * 1e6) / (8.0 * mss)
            per_link_queue_delay[lk] = (total_present / mss) / max(link_pps, 1e-9)
            if total_present <= 0.0:
                link['_queue_history'].append(0.0)
                continue
            drained_bytes = min(total_present, capacity)
            frac = drained_bytes / total_present if total_present > 0 else 0.0
            for fid, b in list(pfq.items()):
                drained_b = b * frac
                per_link_drained_by_flow[lk][fid] = drained_b
                pfq[fid] = max(0.0, pfq[fid] - drained_b)
            remaining = sum(pfq.values())
            buffer_bytes = float(link.get('buffer', 20)) * float(mss)
            drop_bytes = max(0.0, remaining - buffer_bytes)
            if drop_bytes > 0 and remaining > 0:
                drop_frac = drop_bytes / remaining
                for fid, b in list(pfq.items()):
                    drop_for_fid = b * drop_frac
                    pfq[fid] = max(0.0, pfq[fid] - drop_for_fid)
                    dropped_pkts = drop_for_fid / float(mss)
                    flow_dropped_this_step[fid] = flow_dropped_this_step.get(fid, 0.0) + dropped_pkts
                    state[fid]['dropped_cum'] += dropped_pkts
            link['queue_bytes'] = sum(pfq.values())
            link['_queue_history'].append(round(link['queue_bytes'] / float(mss), 6))
        for fid, path_links in flow_to_links.items():
            if not path_links: continue
            st = state[fid]
            min_drained_bytes = float('inf')
            current_queue_delay = 0.0
            for lk in path_links:
                if lk not in links: 
                    min_drained_bytes = 0 # This link doesn't exist, flow is blocked
                    continue
                drained_for_flow_on_link = per_link_drained_by_flow.get(lk, {}).get(fid, 0.0)
                min_drained_bytes = min(min_drained_bytes, drained_for_flow_on_link)
                current_queue_delay += per_link_queue_delay.get(lk, 0.0)
            drained_pkts = min_drained_bytes / float(mss)
            st['delivered'] += drained_pkts
            rtt_sample = st['base_rtt_s'] + current_queue_delay
            current_rtt_steps = max(1, int(round(rtt_sample / dt)))
            ack_step = step + current_rtt_steps
            if ack_step < len(st['ack_schedule']):
                st['ack_schedule'][ack_step] += drained_pkts
            st['throughput_Mbps'] = (drained_pkts * mss * 8.0) / (dt * 1e6) if dt > 0 else 0.0
        for fid, path_links in flow_to_links.items():
            f_cfg = next((f for f in flows if f.get('id') == fid), {})
            algo = (f_cfg.get('algorithm') or 'Reno').lower()
            st = state[fid]
            want_send_pkts = sent_pkts_map.get(fid, 0.0)
            acked = st['ack_schedule'][step]
            st['inflight'] = max(0.0, st['inflight'] + want_send_pkts - acked)
            dropped_this = flow_dropped_this_step.get(fid, 0.0)
            if dropped_this > 0.0: st['full_timer'] += dt
            else: st['full_timer'] = max(0.0, st['full_timer'] - dt)
            rtt_sample = st['base_rtt_s'] + (st['inflight'] / max(1.0, st['cwnd'])) * st['base_rtt_s']
            timeout_like = (dropped_this > 0.0) and (st['full_timer'] >= rtt_sample) 
            dupack_like = (dropped_this > 0.0) and not timeout_like
            cwnd = st['cwnd']
            ssthresh = st['ssthresh']
            phase = st['phase']
            in_fast_recovery = st['in_fast_recovery']
            if algo == 'reno':
                if timeout_like:
                    ssthresh = max(cwnd / 2.0, 2.0)
                    cwnd = 1.0
                    phase = 'slow_start'
                    in_fast_recovery = False
                elif dupack_like:
                    if not in_fast_recovery:
                        ssthresh = max(cwnd / 2.0, 2.0)
                        cwnd = ssthresh
                        in_fast_recovery = True
                        phase = 'congestion_avoidance'
                if phase == 'slow_start':
                    cwnd += acked
                    if cwnd >= ssthresh: phase = 'congestion_avoidance'
                else:
                    cwnd += (acked / max(cwnd, 1.0))
                if in_fast_recovery and acked > 0 and not dupack_like:
                    in_fast_recovery = False
            elif algo == 'cubic':
                W_max = st['W_max']
                epoch_start = st['epoch_start']
                K = st['K']
                W_tcp = st['W_tcp']
                C = st['C']
                beta = st['beta']
                if timeout_like or dupack_like:
                    W_max = cwnd
                    epoch_start = t
                    cwnd = max(cwnd * beta, 2.0)
                    ssthresh = cwnd
                    K = ((W_max * (1.0 - beta)) / C) ** (1.0 / 3.0) if W_max > 0 else 0.0
                    W_tcp = cwnd
                    phase = 'congestion_avoidance'
                if phase == 'slow_start':
                    cwnd += acked
                    if cwnd >= ssthresh:
                        phase = 'congestion_avoidance'
                else:
                    t_cubic = (t + rtt_sample) - epoch_start
                    W_cubic = C * (t_cubic - K) ** 3 + W_max
                    W_tcp += (acked / max(W_tcp, 1.0))
                    if W_cubic < W_tcp: cwnd = W_tcp
                    else:
                        cwnd_target = W_cubic
                        cwnd_diff = cwnd_target - cwnd
                        if cwnd > 0: cwnd += (cwnd_diff / cwnd) * acked
                        else: cwnd += cwnd_diff * acked
                st['W_max'] = W_max
                st['epoch_start'] = epoch_start
                st['K'] = K
                st['W_tcp'] = W_tcp
            elif algo == 'bbr':
                bdp_bytes = (st['bottleneck_bw_mbps'] * 1e6 / 8.0) * rtt_sample
                target_cwnd = max(4.0, 1.0 * (bdp_bytes / mss)) # FIX: 1.0 BDP
                if dropped_this > 0: cwnd = max(4.0, cwnd * 0.8)
                else: cwnd += 0.1 * (target_cwnd - cwnd)
            st['cwnd'] = max(cwnd, 1.0)
            st['ssthresh'] = ssthresh
            st['phase'] = phase
            st['in_fast_recovery'] = in_fast_recovery
            if step % int(0.1 / dt) == 0:
                traces[fid].append({
                    'time': round(t, 3), 'cwnd': round(st['cwnd'], 4),
                    'throughput': round(st['throughput_Mbps'], 6),
                    'buffer': round(sum(links[lk]['queue_bytes'] for lk in path_links if lk in links) / float(mss) if path_links else 0.0, 6),
                    'sent': round(st.get('sent', 0.0), 6),
                    'delivered': round(st.get('delivered', 0.0), 6),
                    'dropped': round(dropped_this, 6),
                    'dropped_cum': round(st.get('dropped_cum', 0.0), 6),
                    'inflight': round(st.get('inflight', 0.0), 6),
                    'phase': st.get('phase', '')
                })
    debug_links = {}
    for lk, v in links.items():
        debug_links[lk] = {
            'bandwidth': v.get('bandwidth'), 'delay': v.get('delay'),
            'buffer': v.get('buffer'), 'mss': v.get('mss'),
            'queue_history': v.get('_queue_history', [])
        }
    return traces, debug_links

# routing and topologyy
def build_graph_from_topology(topology_name, default_link, senders, receivers):
    links = {}
    graph = {}

    def add_link(a, b, params=None):
        key = f"{a}-{b}"
        links[key] = dict(params or default_link)
        graph.setdefault(a, {})[b] = key
        graph.setdefault(b, {})[a] = key

    sender_links = set()
    receiver_links = set()

    # building senders and receivers
    for s_obj in senders:
        s = s_obj.get('id')
        s_attach = s_obj.get('attach') 
        if s and s_attach: 
            sender_links.add((s, s_attach))

    for r_obj in receivers:
        r = r_obj.get('id')
        r_attach = r_obj.get('attach') 
        if r and r_attach: 
            receiver_links.add((r, r_attach))

    topo = (topology_name or 'parallel').lower()
    
    routers = []
    if topo == 'single':
        routers = ['R']
    elif topo == 'series':
        routers = ['R1', 'R2']
        add_link('R1', 'R2', default_link)
    elif topo == 'parallel':
        routers = ['R1', 'R2']
    elif topo == 'triangle':
        routers = ['R1', 'R2', 'R3']
        add_link('R1', 'R2', default_link)
        add_link('R2', 'R3', default_link)
        add_link('R3', 'R1', default_link)
    elif topo == 'branched':
        routers = ['R1', 'R2', 'R3']
        add_link('R1', 'R2', default_link)
        add_link('R1', 'R3', default_link)
    elif topo == 'Four':
        routers = ['R1', 'R2', 'R3', 'R4']
        add_link('R1', 'R2', default_link)
        add_link('R2', 'R3', default_link)
        add_link('R3', 'R4', default_link)
        add_link('R4', 'R1', default_link)
    else: # Fallback
        print(f"Warning: Unknown topology '{topo}'. Falling back to 'parallel'.")
        topo = 'parallel'
        routers = ['R1', 'R2']
    
    for s, attach_point in sender_links:
        if attach_point in routers:
            add_link(s, attach_point, default_link)
        else:
            print(f"Warning: Sender {s} attachment point {attach_point} not in router list: {routers}")

    for r, attach_point in receiver_links:
        if attach_point in routers:
            add_link(attach_point, r, default_link) # Link is from router to receiver
        else:
            print(f"Warning: Receiver {r} attachment point {attach_point} not in router list: {routers}")

    return links, graph


def link_cost_factory(links, alpha_delay=1.0, beta_inv_bw=50.0):
    def cost(linkKey):
        lk = links[linkKey]
        delay = float(lk.get('delay', 15.0))
        bw = float(lk.get('bandwidth', 1.0))
        return alpha_delay * delay + beta_inv_bw * (1.0 / max(0.001, bw))
    return cost

# for finding the best path for the node to transfer the data to the receiver
def dijkstra(graph, start, goal, cost_fn):
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
            # Try the reverse key
            key_rev = graph.get(b, {}).get(a)
            if key_rev:
                lk.append(key_rev)
                continue
            return None # No key found
        lk.append(key)
    return lk


# endpoints to frontend
@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'message': 'backend alive'})


@app.route('/simulate', methods=['POST'])
def simulate():
    try:
        data = request.json or {}
        engine = data.get('engine', 'python') 
        
        algo = data.get('algorithm', 'Reno')
        bw = float(data.get('bandwidth', 5))
        delay = float(data.get('delay', 10))
        buffer_size = int(data.get('buffer', 50))
        duration = float(data.get('duration', 10))
        mss = int(data.get('mss', 1500))
    except Exception as e:
        print(f"Error parsing request: {e}")
        return jsonify({'error': str(e)}), 400

    try:
        if engine == 'ns3':
            print("--- Running simulation with ns-3 ---")
            trace = run_simulation_ns3(algo, bw, delay, buffer_size, duration, mss)
        else:
            print("--- Running simulation with Python ---")
            trace = run_simulation(algo, bw, delay, buffer_size, duration, mss)
        
        return jsonify({'success': True, 'trace': trace})
    
    except Exception as e:
        tb = traceback.format_exc()
        print(f"Simulation failed: {e}\n{tb}")
        return jsonify({'success': False, 'error': f"Simulation Engine Error: {e}", 'traceback': tb}), 500


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
    header = ['time', 'cwnd', 'throughput', 'buffer', 'inflight', 'sent', 'delivered', 'dropped', 'phase']
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
        # get from payload
        senders = body.get('senders', []) or []
        receivers = body.get('receivers', []) or []
    except Exception as e:
        return jsonify({'success': False, 'error': f'bad request: {e}'}), 400

    try:
        default_link = {
            'bandwidth': float(link_params.get('bandwidth', 5.0)),
            'delay': float(link_params.get('delay', 15.0)),
            'buffer': int(link_params.get('buffer', 20)),
            'mss': int(link_params.get('mss', 1500))
        }
        duration = float(link_params.get('duration', 20.0))
        dt = float(link_params.get('dt', 0.05))

        # pass senders/receivers to builder
        links, graph = build_graph_from_topology(topology, default_link, senders, receivers)

        for lk_name, overrides in (link_overrides or {}).items():
            if lk_name in links:
                for k, v in overrides.items():
                    if k in ('bandwidth', 'delay'):
                        links[lk_name][k] = float(v)
                    elif k in ('buffer', 'mss'):
                        links[lk_name][k] = int(v)

        cost_fn = link_cost_factory(links)
        paths = {}

        # round robin for parallel routing (trial)
        if topology == 'parallel' and len(flows) > 0:
            print("[Router] Using special 'parallel' topology routing...")
            
            unique_pairs = set()
            for f in flows:
                unique_pairs.add((f.get('src'), f.get('dst')))

            pair_manual_paths = {}
            for src, dst in unique_pairs:
                if not src or not dst: continue
                manual_paths = []
            # find path
                try:
                    nodes_path_1_A = dijkstra(graph, src, 'R1', cost_fn)
                    nodes_path_1_B = dijkstra(graph, 'R1', dst, cost_fn)
                    if nodes_path_1_A and nodes_path_1_B:
                        full_path_1_nodes = nodes_path_1_A + nodes_path_1_B[1:]
                        path1_links = nodes_to_linkkeys(full_path_1_nodes, graph)
                        if path1_links:
                            manual_paths.append(path1_links)
                            print(f"[Router] Found path {src}->{dst} via R1: {path1_links}")
                except Exception as e:
                    print(f"Could not find path {src}->{dst} via R1: {e}")

                try:
                    nodes_path_2_A = dijkstra(graph, src, 'R2', cost_fn)
                    nodes_path_2_B = dijkGistra(graph, 'R2', dst, cost_fn)
                    if nodes_path_2_A and nodes_path_2_B:
                        full_path_2_nodes = nodes_path_2_A + nodes_path_2_B[1:]
                        path2_links = nodes_to_linkkeys(full_path_2_nodes, graph)
                        if path2_links:
                            manual_paths.append(path2_links)
                            print(f"[Router] Found path {src}->{dst} via R2: {path2_links}")
                except Exception as e:
                    print(f"Could not find path {src}->{dst} via R2: {e}")
                
                pair_manual_paths[(src, dst)] = manual_paths

            flow_counts_per_pair = {}
            for f in flows:
                fid = f.get('id')
                src = f.get('src'); dst = f.get('dst')
                available_paths = pair_manual_paths.get((src, dst))
                
                if not available_paths:
                    print(f"[Router] Warning: Could not find manual paths for {src}->{dst}. Falling back to dijkstra for flow {fid}.")
                    nodes_path = dijkstra(graph, src, dst, cost_fn)
                    paths[fid] = nodes_to_linkkeys(nodes_path, graph) or []
                else:
                    pair_key = (src, dst)
                    flow_index = flow_counts_per_pair.get(pair_key, 0)
                    chosen_path_links = available_paths[flow_index % len(available_paths)]
                    paths[fid] = chosen_path_links
                    flow_counts_per_pair[pair_key] = flow_index + 1
                    print(f"[Router] Assigned flow {fid} ({src}->{dst}) to path: {chosen_path_links}")

        else:
            # djikstra
            print(f"[Router] Using standard dijkstra routing for topology: {topology}")
            for f in flows:
                fid = f.get('id')
                src = f.get('src'); dst = f.get('dst')
                if not src or not dst:
                    paths[fid] = []
                    continue
                nodes_path = dijkstra(graph, src, dst, cost_fn)
                if not nodes_path:
                    print(f"ERROR: No path found for {fid} from {src} to {dst}")
                    paths[fid] = []
                else:
                    linkkeys = nodes_to_linkkeys(nodes_path, graph) or []
                    print(f"Path for {fid}: {linkkeys}")
                    paths[fid] = linkkeys

        sim_out = simulate_flows(flows=flows, links=links, paths=paths, duration=duration, dt=dt, mss=default_link['mss'])
        if isinstance(sim_out, tuple) and len(sim_out) == 2:
            traces, debug_links = sim_out
        else:
            traces = sim_out
            debug_links = {k: v for k, v in links.items()}

        debug_info = {'links': debug_links, 'paths': paths, 'graph_nodes': list(graph.keys())}

        return jsonify({'success': True, 'traces': traces, 'debug': debug_info}), 200

    except Exception as e:
        tb = traceback.format_exc()
        print("simulate_multi ERROR:\n", tb)
        return jsonify({'success': False, 'error': str(e), 'traceback': tb, 'request_body': body}), 500


if __name__ == '__main__':
    app.run(host='localhost', port=5001, debug=True)