import math
from collections import defaultdict

def simulate_flows(flows, links, paths, duration=20.0, dt=0.1, mss=1500):
    # normalize link fields and compute bytes_per_sec capacity
    for lk, l in links.items():
        l.setdefault('bandwidth', 1.0)
        l.setdefault('delay', 15.0)
        l.setdefault('buffer', 20)
        l.setdefault('mss', mss)
        l['bytes_per_sec'] = float(l['bandwidth']) * 1e6 / 8.0

    # initialize state per flow
    state = {}
    for f in flows:
        fid = f.get('id') or f"{f.get('src','N0')}-{f.get('dst','N1')}"
        state[fid] = {
            'cwnd': 1.0,
            'inflight': 0.0,
            'throughput_Mbps': 0.0,
        }

    # precompute which flows share each link
    link_to_flows = defaultdict(list)
    for f in flows:
        fid = f.get('id') or f"{f.get('src','N0')}-{f.get('dst','N1')}"
        for lk in paths.get(fid, []):
            link_to_flows[lk].append(fid)

    traces = { (f.get('id') or f"{f.get('src','N0')}-{f.get('dst','N1')}"): [] for f in flows }

    t = 0.0
    while t <= duration + 1e-9:
        # for each link compute available bytes this dt
        link_available_bytes = {}
        for lk, l in links.items():
            link_available_bytes[lk] = l['bytes_per_sec'] * dt

        # for each flow decide sends and deliveries
        for f in flows:
            fid = f.get('id') or f"{f.get('src','N0')}-{f.get('dst','N1')}"
            algo = f.get('algorithm', 'reno').lower()
            st = state[fid]

            want_send = max(0, int(max(0.0, st['cwnd'] - st['inflight'])))
            path_links = paths.get(fid, [])
            if not path_links:
                delivered_pkts = 0
            else:
                deliverable_pkts_per_link = []
                for lk in path_links:
                    avail_bytes = link_available_bytes.get(lk, 0.0)
                    num_flows_on_link = max(1, len(link_to_flows.get(lk, [])))
                    share_bytes = avail_bytes / num_flows_on_link
                    link_mss = links[lk].get('mss', mss)
                    deliverable_pkts_per_link.append(int(share_bytes / max(1, link_mss)))
                delivered_pkts = min(want_send, min(deliverable_pkts_per_link) if deliverable_pkts_per_link else 0)

                used_bytes = delivered_pkts * mss
                for lk in path_links:
                    link_available_bytes[lk] = max(0.0, link_available_bytes[lk] - used_bytes)

            # update inflight
            st['inflight'] = max(0.0, st['inflight'] + want_send - delivered_pkts)
            # throughput in Mbps
            st['throughput_Mbps'] = (delivered_pkts * mss * 8.0) / (dt * 1e6) if dt > 0 else 0.0

            # algorithms
            if algo == 'reno':
                if delivered_pkts >= want_send and st['cwnd'] < 1000:
                    st['cwnd'] += 0.2
                else:
                    st['cwnd'] = max(1.0, st['cwnd'] * 0.7)
            elif algo == 'cubic':
                if delivered_pkts >= want_send and st['cwnd'] < 2000:
                    st['cwnd'] += 0.5
                else:
                    st['cwnd'] = max(1.0, st['cwnd'] * 0.75)
            else:  # bbr
                rtt_s = 0.05
                if paths.get(fid):
                    total_delay_ms = sum(links[lk].get('delay', 15.0) for lk in paths[fid])
                    rtt_s = max(0.001, (total_delay_ms * 2) / 1000.0)
                if paths.get(fid):
                    bps = min(links[lk].get('bandwidth', 1.0) for lk in paths[fid]) * 1e6
                else:
                    bps = 1e6
                bdp_bytes = bps * rtt_s
                target_pkts = max(1.0, bdp_bytes / mss)
                st['cwnd'] += 0.2 * (target_pkts - st['cwnd'])

            st['cwnd'] = max(0.1, st['cwnd'])

            traces[fid].append({
                'time': round(t, 3),
                'cwnd': round(st['cwnd'], 3),
                'throughput': round(st['throughput_Mbps'], 3),
                'buffer': 0
            })

        t += dt

    return traces
