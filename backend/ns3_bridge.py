import os, subprocess, csv, json

NS3_DIR = os.environ.get("NS3_DIR", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ns3")))

def run_single(algo="Reno", bandwidth=5, delay=50, buffer_pkts=20, duration=20, mss=1500):
    cmd = [
        "./waf", "--run",
        f"tcp_single --algo={algo} --rate={bandwidth}Mbps --delay={delay}ms "
        f"--bufferPkts={buffer_pkts} --duration={duration} --mss={mss}"
    ]
    proc = subprocess.run(cmd, cwd=NS3_DIR, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip())

    trace_csv = os.path.join(NS3_DIR, "trace.csv")
    out = []
    with open(trace_csv) as f:
        reader = csv.DictReader(f)
        for r in reader:
            out.append({
                "time": float(r["time"]),
                "cwnd": float(r["cwnd_pkts"]),
                "throughput": float(r["throughput_mbps"]),
                "buffer": None, "inflight": None, "phase": "ns3"
            })
    return out

def run_multi(flow_algos, bandwidth=5, delay=50, buffer_pkts=20, duration=20, mss=1500):
    flows_arg = ",".join(flow_algos)
    cmd = [
        "./waf", "--run",
        f"tcp_multi --flows={flows_arg} --rate={bandwidth}Mbps --delay={delay}ms "
        f"--bufferPkts={buffer_pkts} --duration={duration} --mss={mss}"
    ]
    proc = subprocess.run(cmd, cwd=NS3_DIR, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip())

    traces = {}
    for i in range(len(flow_algos)):
        p = os.path.join(NS3_DIR, f"trace_flow{i}.csv")
        series = []
        with open(p) as f:
            reader = csv.DictReader(f)
            for r in reader:
                series.append({
                    "time": float(r["time"]),
                    "cwnd": float(r["cwnd_pkts"]),
                    "throughput": float(r["throughput_mbps"]),
                    "buffer": None, "inflight": None, "phase": "ns3"
                })
        traces[str(i)] = series
    return traces
