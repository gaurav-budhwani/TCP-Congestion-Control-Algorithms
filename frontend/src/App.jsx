import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from 'recharts';
import { Play, Pause, RotateCcw, Settings, Server, Router, Download, X } from 'lucide-react';

const BACKEND = 'http://localhost:5001';

const ALGORITHM_INFO = {
  Reno: {
    title: "TCP Reno",
    description: "TCP Reno is the classic, loss-based algorithm that defined the 'sawtooth' pattern. It's the foundation upon which most other algorithms (like Cubic) are built.",
    how: [
      "<strong>Slow Start:</strong> The congestion window (CWND) grows exponentially (doubling every RTT) until it hits a threshold (ssthresh).",
      "<strong>Congestion Avoidance:</strong> After hitting the threshold, the CWND grows linearly (adding +1 every RTT). This is the 'Additive Increase' phase.",
      "<strong>Fast Retransmit (Packet Loss):</strong> When a packet is lost (signaled by 3 duplicate ACKs), Reno performs a 'Multiplicative Decrease'. It cuts the CWND in half (e.g., 60 -> 30) and sets the ssthresh to this new value.",
      "<strong>Timeout (Severe Loss):</strong> If ACKs stop completely, a timeout occurs. This is a severe event, and Reno resets the CWND all the way back to 1."
    ],
    graph: "Look for the classic 'sawtooth' graph. You'll see an initial exponential spike (Slow Start), followed by a long, linear ramp-up (Additive Increase). When the router buffer is full (see 'Router Queue' graph), packets drop, and the CWND is instantly cut in half, starting the next sawtooth."
  },
  Cubic: {
    title: "TCP Cubic",
    description: "Cubic is the default TCP in Linux, Windows, and macOS. It's designed for modern, high-speed networks with long delays (high Bandwidth-Delay Product).",
    how: [
      "<strong>Slow Start:</strong> Same as Reno.",
      "<strong>Congestion Avoidance:</strong> This is the key difference. Instead of a straight line, it uses a 'cubic' S-shaped function. It grows very fast, then flattens out as it approaches the last known maximum, and then accelerates again to probe for new bandwidth.",
      "<strong>Loss Detection:</strong> When a loss occurs, Cubic cuts its window by only 30% (vs. Reno's 50%), making it less aggressive.",
      "<strong>RTT-Independent:</strong> Its growth function is based on *time*, not RTTs. This makes it much fairer to flows that have different ping times on the same network."
    ],
    graph: "The CWND graph will not be a straight line. It will be a smoother 'S' curve. You'll see it grow fast, then appear to slow down or flatten, then grow fast again. The drops from packet loss are also less severe (e.g., 60 -> 42) than Reno's."
  },
  BBR: {
    title: "TCP BBR",
    description: "BBR (Bottleneck Bandwidth and RTT) is a completely different, model-based algorithm from Google. It does not use packet loss as its signal for congestion.",
    how: [
      "<strong>No Loss-Based Control:</strong> BBR ignores packet loss and does not have a sawtooth. Its goal is to maximize throughput while keeping router queues empty.",
      "<strong>Finding the BDP:</strong> BBR constantly measures two things: <strong>Bottleneck Bandwidth (BtlBw)</strong> (the link's max speed) and <strong>Round-Trip Time (RTTime)</strong> (the link's min delay).",
      "<strong>Pacing:</strong> It calculates the Bandwidth-Delay Product (BDP) and tries to keep the `cwnd` exactly at the BDP, sending packets at a smooth, 'paced' rate.",
      "<strong>Probing:</strong> It periodically probes for more bandwidth (by sending slightly faster) and for lower RTT (by sending slightly slower to drain the queue)."
    ],
    graph: "The graphs will look totally different. You should see the CWND and Inflight packets shoot up to find the BDP and then stay relatively flat. The 'Router Queue' graph should be the most interesting: BBR's goal is to keep it near-zero, while Reno and Cubic *must* fill it up to detect loss."
  }
};

// --- TopologyBuilder Component (from history) ---
function TopologyBuilder({ backend, onResult, onPlay, onReset }) {
  const [topology, setTopology] = useState("parallel");
  const [senders, setSenders] = useState([{ id: "N0", attach: "R1" }]);
  const [receivers, setReceivers] = useState([{ id: "N2", attach: "R2" }]);
  
  const [flows, setFlows] = useState([]);
  const [linkParams, setLinkParams] = useState({ bandwidth: 5, delay: 50, buffer: 20, duration: 20, mss: 1500, dt: 0.05 });
  const [linkOverrides, setLinkOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [showLinkEditor, setShowLinkEditor] = useState(false);
  const [debug, setDebug] = useState(null);

  const [newSenderName, setNewSenderName] = useState("N1");
  const [newSenderAttach, setNewSenderAttach] = useState("R1");
  const [newReceiverName, setNewReceiverName] = useState("N3");
  const [newReceiverAttach, setNewReceiverAttach] = useState("R2");

  const [newFlowSrc, setNewFlowSrc] = useState(senders[0]?.id || "");
  const [newFlowDst, setNewFlowDst] = useState(receivers[0]?.id || "");
  const [newFlowAlgo, setNewFlowAlgo] = useState("Reno");
  
  const uniqueSenderNames = useMemo(() => Array.from(new Set(senders.map(s => s.id))), [senders]);
  const uniqueReceiverNames = useMemo(() => Array.from(new Set(receivers.map(r => r.id))), [receivers]);

  useEffect(() => {
    if (!uniqueSenderNames.includes(newFlowSrc)) {
      setNewFlowSrc(uniqueSenderNames[0] || "");
    }
  }, [uniqueSenderNames, newFlowSrc]);

  useEffect(() => {
    if (!uniqueReceiverNames.includes(newFlowDst)) {
      setNewFlowDst(uniqueReceiverNames[0] || "");
    }
  }, [uniqueReceiverNames, newFlowDst]);

  const routerList = useMemo(() => {
    if (topology === "single") return ["R"];
    if (topology === "series") return ["R1", "R2"];
    if (topology === "parallel") return ["R1", "R2"];
    if (topology === "triangle") return ["R1", "R2", "R3"];
    if (topology === "branched") return ["R1", "R2", "R3"];
    if (topology === "Four") return ["R1", "R2", "R3", "R4"];
    return ["R1", "R2"];
  }, [topology]);

  useEffect(() => {
    if (!routerList.includes(newSenderAttach)) setNewSenderAttach(routerList[0]);
    if (!routerList.includes(newReceiverAttach)) setNewReceiverAttach(routerList[routerList.length - 1] || routerList[0]);
  }, [routerList]);

  const allNodeNames = useMemo(() => {
    return Array.from(new Set([
      ...routerList,
      ...senders.map(s => s.id),
      ...receivers.map(r => r.id)
    ]));
  }, [routerList, senders, receivers]);

  const logicalLinks = useMemo(() => {
    const links = [];
    const push = (a,b)=> links.push(`${a}-${b}`);
    
    if (topology === "series") {
      push('R1','R2');
    } else if (topology === "parallel") {
      // No R-R links
    } else if (topology === "triangle") {
      push('R1','R2'); push('R2','R3'); push('R3','R1');
    } else if (topology === "branched") {
      push('R1','R2'); push('R1','R3');
    } else if (topology === "Four") {
      push('R1','R2'); push('R2','R3');
      push('R3','R4'); push('R4','R1');
    }
    
    senders.forEach(s => push(s.id, s.attach));
    receivers.forEach(r => push(r.attach, r.id));
    
    return Array.from(new Set(links));
  }, [topology, senders, receivers]);

  const nextNodeName = (prefix = 'N') => {
    let i = 0;
    while (allNodeNames.includes(`${prefix}${i}`)) {
      i++;
    }
    if (!allNodeNames.includes('N0')) return 'N0';
    if (!allNodeNames.includes('N1')) return 'N1';
    if (!allNodeNames.includes('N2')) return 'N2';
    if (!allNodeNames.includes('N3')) return 'N3';
    return `${prefix}${i}`; // Fallback
  };

  useEffect(() => {
    setNewSenderName(nextNodeName());
  }, [senders, routerList]);

  useEffect(() => {
    setNewReceiverName(nextNodeName());
  }, [receivers, routerList, senders]);

  const addSender = () => {
    const otherNodeNames = [ ...routerList, ...receivers.map(r => r.id) ];
    if (!newSenderName || otherNodeNames.includes(newSenderName)) {
      alert(`Node name "${newSenderName}" is invalid or already taken by a router or receiver.`);
      return;
    }
    const existing = senders.find(s => s.id === newSenderName && s.attach === newSenderAttach);
    if (existing) {
      alert(`Attachment ${newSenderName} -> ${newSenderAttach} already exists.`);
      return;
    }
    setSenders(s => [...s, { id: newSenderName, attach: newSenderAttach }]);
  };
  
  const addReceiver = () => {
    const otherNodeNames = [ ...routerList, ...senders.map(s => s.id) ];
    if (!newReceiverName || otherNodeNames.includes(newReceiverName)) {
      alert(`Node name "${newReceiverName}" is invalid or already taken by a router or sender.`);
      return;
    }
    const existing = receivers.find(r => r.id === newReceiverName && r.attach === newReceiverAttach);
    if (existing) {
      alert(`Attachment ${newReceiverAttach} -> ${newReceiverName} already exists.`);
      return;
    }
    setReceivers(r => [...r, { id: newReceiverName, attach: newReceiverAttach }]);
  };

  const removeSender = (id, attach) => { 
    setSenders(s => s.filter(x => !(x.id === id && x.attach === attach))); 
    setFlows(f => f.filter(x => !(x.src === id && x.src_attach_used_for_id === attach))); 
  };
  const removeReceiver = (id, attach) => { 
    setReceivers(r => r.filter(x => !(x.id === id && x.attach === attach))); 
    setFlows(f => f.filter(x => !(x.dst === id && x.dst_attach_used_for_id === attach))); 
  };

  const addFlow = (src, dst, algo='Reno') => {
    if (!src||!dst) { alert("Please select a sender and receiver."); return; } 
    if (src===dst) { alert('Source and destination must be different'); return; }

    const baseId = `${src}->${dst}`;
    let finalId = `${baseId} (${algo})`;
    let counter = 1;
    
    while (flows.some(f => f.id === finalId)) {
      finalId = `${baseId} (${algo}) #${counter+1}`;
      counter++;
    }
    
    setFlows(f=>[...f, {
      id: finalId, 
      src, 
      dst, 
      algorithm: algo,
      src_attach_used_for_id: senders.find(s => s.id === src)?.attach,
      dst_attach_used_for_id: receivers.find(r => r.id === dst)?.attach
    }]);
  };
  
  const removeFlow = id => setFlows(f=>f.filter(x=>x.id!==id));

  const updateLinkOverride = (lk, partial) => {
    setLinkOverrides(prev => {
      const next = { ...(prev||{}) };
      next[lk] = { ...(next[lk]||{}) };
      Object.entries(partial).forEach(([k,v])=> {
        if (v === "" || v === null || typeof v === 'undefined') delete next[lk][k];
        else next[lk][k] = (k==='buffer' ? parseInt(v,10) : Number(v));
      });
      if (Object.keys(next[lk]).length === 0) delete next[lk];
      return next;
    });
  };

  async function run() {
    if (!flows.length) { alert('Add at least one flow'); return; }
    setBusy(true); setDebug(null); onReset?.();
    try {
      const cleanFlows = flows.map(f => ({
        id: f.id,
        src: f.src,
        dst: f.dst,
        algorithm: f.algorithm
      }));

      const payload = { 
        topology, 
        linkParams, 
        flows: cleanFlows,
        linkOverrides,
        senders,
        receivers 
      };

      console.log('simulate_multi payload', payload);
      const res = await axios.post(`${backend}/simulate_multi`, payload, { timeout: 600000 });
      console.log('simulate_multi response', res && res.data ? res.data : res);
      if (!res.data) { alert('No JSON from server'); setBusy(false); return; }
      if (res.data.success === false) {
        alert('Backend error: ' + (res.data.error || 'unknown') + (res.data.traceback ? '\n\nSee console for traceback' : ''));
        setDebug(res.data);
        setBusy(false);
        return;
      }
      const traces = res.data.traces || {};
      const dbg = res.data.debug || {};
      setDebug(dbg||null);
      onResult?.(traces||{}, dbg||null);
      onPlay?.();
    } catch(err) {
      console.error('simulate_multi failed', err, err?.response?.data);
      const server = err?.response?.data;
      if (server) {
        alert('Multi-run failed — server error (see debug pane)');
        setDebug(server);
      } else {
        alert('Multi-run failed. Check backend console.');
      }
    } finally { setBusy(false); }
  }

  const clearOverride = (lk) => setLinkOverrides(prev=>{const c={...(prev||{})}; delete c[lk]; return c;});

  return (
    <div style={{ display:'flex', gap: 18 }}>
      <div style={{ width:360 }}>
        <div style={{ padding:12, borderRadius:10, background:'#fff' }}>
          <h3 style={{marginTop:0}}>Multi-flow Builder</h3>

          <label>Topology</label>
          <select value={topology} onChange={e=>setTopology(e.target.value)}>
            <option value="single">Single</option>
            <option value="series">Series</option>
            <option value="parallel">Parallel</option>
            <option value="triangle">Triangle</option>
            <option value="branched">Branched</option>
            <option value="Four">Four (Mesh)</option>
          </select>

          {/* ... Link Params ... */}
          <div style={{ marginTop:8 }}>
            <label>Bandwidth: {linkParams.bandwidth} Mbps</label>
            <input type="range" min="1" max="200" value={linkParams.bandwidth}
              onChange={e=>setLinkParams({...linkParams, bandwidth: Number(e.target.value)})} />
          </div>
          <div>
            <label>Delay: {linkParams.delay} ms</label>
            <input type="range" min="1" max="300" value={linkParams.delay}
              onChange={e=>setLinkParams({...linkParams, delay: Number(e.target.value)})} />
          </div>
          <div>
            <label>Buffer: {linkParams.buffer} pkts</label>
            <input type="range" min="1" max="500" value={linkParams.buffer}
              onChange={e=>setLinkParams({...linkParams, buffer: Number(e.target.value)})} />
          </div>
          <div>
            <label>Duration: {linkParams.duration}s</label>
            <input type="range" min="5" max="120" value={linkParams.duration}
              onChange={e=>setLinkParams({...linkParams, duration: Number(e.target.value)})} />
          </div>
          
          <div style={{ display:'flex', justifyContent: 'flex-end', gap:8, marginTop:10 }}>
            <button onClick={()=>setShowLinkEditor(s=>!s)}>{showLinkEditor ? 'Hide Links' : 'Edit Links'}</button>
          </div>

          
          <div style={{ borderTop: '1px solid #eee', paddingTop: 10, marginTop: 10 }}>
            <strong>Senders</strong>
            <div style={{display: 'flex', gap: 8, marginTop: 6, marginBottom: 6}}>
              <input 
                type="text" 
                value={newSenderName} 
                onChange={e => setNewSenderName(e.target.value.toUpperCase())}
                placeholder="Node Name (e.g. N1)"
                style={{flex: 1}}
              />
              <select value={newSenderAttach} onChange={e=>setNewSenderAttach(e.target.value)}>
                {routerList.map(r => <option key={r} value={r}>Attach to {r}</option>)}
              </select>
              <button onClick={addSender}>+</button>
            </div>
            {senders.map(s => (
              <div key={`${s.id}-${s.attach}`} style={{ display:'flex', justifyContent:'space-between', alignItems: 'center', marginTop:4, padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                <div>{s.id} &rarr; {s.attach}</div>
                <button onClick={()=>removeSender(s.id, s.attach)} style={{padding: 2, background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer'}}><X size={16}/></button>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid #eee', paddingTop: 10, marginTop: 10 }}>
            <strong>Receivers</strong>
            <div style={{display: 'flex', gap: 8, marginTop: 6, marginBottom: 6}}>
              <input 
                type="text" 
                value={newReceiverName} 
                onChange={e => setNewReceiverName(e.target.value.toUpperCase())}
                placeholder="Node Name (e.g. N3)"
                style={{flex: 1}}
              />
              <select value={newReceiverAttach} onChange={e=>setNewReceiverAttach(e.target.value)}>
                {routerList.map(r => <option key={r} value={r}>Attach to {r}</option>)}
              </select>
              <button onClick={addReceiver}>+</button>
            </div>
            {receivers.map(r => (
              <div key={`${r.id}-${r.attach}`} style={{ display:'flex', justifyContent:'space-between', alignItems: 'center', marginTop:4, padding: 4, background: '#f8fafc', borderRadius: 4 }}>
                <div>{r.attach} &rarr; {r.id}</div>
                <button onClick={()=>removeReceiver(r.id, r.attach)} style={{padding: 2, background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer'}}><X size={16}/></button>
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid #eee', paddingTop: 10, marginTop: 10 }}>
            <strong>Add flow</strong>
            <div style={{ display:'flex', gap:8, marginTop:6 }}>
              <select value={newFlowSrc} onChange={e=>setNewFlowSrc(e.target.value)} style={{flex:1}}>
                <option value="">Sender...</option>
                {uniqueSenderNames.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
              <select value={newFlowDst} onChange={e=>setNewFlowDst(e.target.value)} style={{flex:1}}>
                <option value="">Receiver...</option>
                {uniqueReceiverNames.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
              <select value={newFlowAlgo} onChange={e=>setNewFlowAlgo(e.target.value)} style={{flex:1}}>
                <option value="Reno">Reno</option><option value="Cubic">Cubic</option><option value="BBR">BBR</option>
              </select>
              <button onClick={()=>addFlow(newFlowSrc, newFlowDst, newFlowAlgo)}>Add</button>
            </div>

            <div style={{ marginTop: 6, maxHeight: 100, overflowY: 'auto' }}>
              {flows.map(f => (
                <div key={f.id} style={{ display:'flex', justifyContent:'space-between', alignItems: 'center', padding:6, border:'1px solid #eee', borderRadius:6, marginTop:6 }}>
                  <div>{f.id} <small style={{color:'#666'}}>({f.algorithm})</small></div>
                  <button onClick={()=>removeFlow(f.id)} style={{padding: 2, background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer'}}><X size={16}/></button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display:'flex', gap:8, marginTop:12 }}>
            <button onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run Multi'}</button>
            <button onClick={() => { 
              setFlows([]); 
              setSenders([{ id: "N0", attach: "R1" }]); 
              setReceivers([{ id: "N2", attach: "R2" }]); 
              setDebug(null); 
              onResult?.({}); 
              onReset?.(); 
            }}>Clear</button>
          </div>
        </div>

        {showLinkEditor && (
          <div style={{ marginTop:12, padding:12, borderRadius:8, background:'#fff' }}>
            <strong>Edit Links (per-link override)</strong>
            <div style={{ maxHeight:220, overflow:'auto', marginTop:8 }}>
              {logicalLinks.map(lk => {
                const override = linkOverrides[lk] || {};
                return (
                  <div key={lk} style={{ border:'1px solid #f0f0f0', padding:8, borderRadius:6, marginBottom:8 }}>
                    <div style={{ display:'flex', justifyContent:'space-between' }}>
                      <div style={{ fontWeight:600 }}>{lk}</div>
                      <div><button onClick={()=>clearOverride(lk)}>Clear</button></div>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginTop:6 }}>
                      <div>
                        <label>BW (Mbps)</label>
                        <input type="number" value={override.bandwidth ?? ""} placeholder={String(linkParams.bandwidth)}
                          onChange={e=>updateLinkOverride(lk, { bandwidth: e.target.value === "" ? undefined : Number(e.target.value) })} />
                      </div>
                      <div>
                        <label>Delay (ms)</label>
                        <input type="number" value={override.delay ?? ""} placeholder={String(linkParams.delay)}
                          onChange={e=>updateLinkOverride(lk, { delay: e.target.value === "" ? undefined : Number(e.target.value) })} />
                      </div>
                      <div>
                        <label>Buffer (pkts)</label>
                        <input type="number" value={override.buffer ?? ""} placeholder={String(linkParams.buffer)}
                          onChange={e=>updateLinkOverride(lk, { buffer: e.target.value === "" ? undefined : parseInt(e.target.value, 10) })} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ padding:12, borderRadius:10, background:'#fff' }}>
          <h3 style={{ marginTop:0 }}>Topology</h3>
          <div style={{ border:'1px solid #eef2f7', borderRadius:8, padding:10, minHeight:200 }}>
            <svg width="100%" height="260" viewBox="0 0 640 260" preserveAspectRatio="xMinYMin meet">
              {(() => {
                const elems = [];
                const nodePos = {};
                
                const node = (name, x, y, fill) => {
                  if (nodePos[name]) return nodePos[name];

                  const isRouter = name.startsWith('R');
                  if (isRouter) {
                    elems.push(<g key={name}><rect x={x-18} y={y-18} width="36" height="36" rx="6" fill={fill || "#0f172a"}/><text x={x} y={y+5} textAnchor="middle" fill="#fff">{name}</text></g>);
                  } else {
                    elems.push(<g key={name}><circle cx={x} cy={y} r="20" fill={fill || "#cbd5e1"}/><text x={x} y={y+5} textAnchor="middle">{name}</text></g>);
                  }
                  nodePos[name] = {x,y};
                  return {x,y};
                };
                
                const S_X = 80, R_X1 = 220, R_X2 = 380, N_X = 560;
                const MID_Y = 130;
                const TOP_Y = 70;
                const BOT_Y = 190;
                
                if (topology === "single") {
                  node('R', 320, MID_Y);
                } else if (topology === "series") {
                  node('R1', R_X1, MID_Y);
                  node('R2', R_X2, MID_Y);
                } else if (topology === "parallel") {
                  node('R1', 320, TOP_Y);
                  node('R2', 320, BOT_Y);
                } else if (topology === "triangle") {
                  node('R1', R_X1, TOP_Y);
                  node('R2', R_X2, MID_Y);
                  node('R3', R_X1, BOT_Y);
                } else if (topology === "branched") {
                  node('R1', R_X1, MID_Y);
                  node('R2', R_X2, TOP_Y);
                  node('R3', R_X2, BOT_Y);
                } else if (topology === "Four") { 
                  node('R1', R_X1, TOP_Y);
                  node('R2', R_X2, TOP_Y);
                  node('R3', R_X2, BOT_Y);
                  node('R4', R_X1, BOT_Y);
                }
  
                const uniqueSenders = Array.from(new Set(senders.map(s => s.id)));
                uniqueSenders.forEach((id, i) => node(id, S_X, TOP_Y + i*60, "#cbd5e1"));
                
                const uniqueReceivers = Array.from(new Set(receivers.map(r => r.id)));
                uniqueReceivers.forEach((id, i) => node(id, N_X, TOP_Y + i*60, "#d1fae5"));

                logicalLinks.forEach((lk,idx) => {
                  const [a,b] = lk.split('-');
                  const p1 = nodePos[a];
                  const p2 = nodePos[b];
                  if (p1 && p2) { 
                    elems.push(<line key={'L'+idx} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#94a3b8" strokeWidth="3" strokeLinecap="round" />);
                  }
                });

                return elems.reverse(); // Render lines first, then nodes
              })()}
            </svg>
          </div>

          {debug && (
            <div style={{ marginTop:10, padding:8, border:'1px dashed #e2e8f0', borderRadius:8 }}>
              <strong>Debug (paths & links)</strong>
              <pre style={{ maxHeight:200, overflow:'auto', margin:6, fontSize:12 }}>{JSON.stringify(debug, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// --- END: TopologyBuilder Component ---


const AlgorithmInfoCard = ({ algorithm }) => {
  const info = useMemo(() => {
    return ALGORITHM_INFO[algorithm] || { title: "Unknown", description: "", how: [], graph: "" };
  }, [algorithm]);

  return (
    <div className="card" style={{ marginTop: 16}}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{info.title}
      </h2>
      <p>{info.description}</p>
      <h3>How it Works</h3>
      <ul style={{ paddingLeft: 20, lineHeight: 1.6 }}>
        {info.how.map((item, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: item }} />
        ))}
      </ul>
      <h3>What to Look For in the Graph</h3>
      <p>{info.graph}</p>
    </div>
  );
};

const DataChart = ({ title, data, dataKey, stroke, fill, isArea = false, currentTime, height = 260, style = {} }) => {
  const ChartComponent = isArea ? AreaChart : LineChart;
  const ChartElement = isArea ? Area : Line;

  const cardHeight = data.length > 0 ? height : 150;

  return (
    <div className="card" style={{ height: cardHeight, display: 'flex', flexDirection: 'column', ...style }}>
      <h3 style={{ marginBottom: 10, flexShrink: 0 }}>{title}</h3>
      <div style={{ flexGrow: 1, width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ChartComponent data={data}>
            <CartesianGrid stroke="#334155" opacity={0.2}/>
            <XAxis dataKey="time" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip />
            <ReferenceLine x={currentTime} stroke="white" strokeDasharray="3 3"/>
            <ChartElement
              type="monotone"
              dataKey={dataKey}
              stroke={stroke}
              fill={isArea ? fill : 'none'}
              fillOpacity={0.2}
              dot={false}
              isAnimationActive={false}
            />
          </ChartComponent>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

function App() {
  const [engine, setEngine] = useState('python');
  const [mode, setMode] = useState('single');
  const [config, setConfig] = useState({ algorithm:'Reno', bandwidth:5, delay:50, buffer:20, duration:20, mss:1500 });
  const [data, setData] = useState(null);
  const [multiData, setMultiData] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const lastOf = arr => (arr && arr.length ? arr[arr.length - 1] : undefined);

  const handleConfigChange = (e) => {
    const { name, value, type } = e.target;
    const parsedValue = (type === 'range' || type === 'number') ? parseInt(value) : value;
    setConfig(prev => ({ ...prev, [name]: parsedValue }));
  };

  const runSim = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await axios.post(`${BACKEND}/simulate`, {
        engine: engine,
        ...config,
      });
      
      if (!res.data) throw new Error('Bad response');
      if (res.data.success === false) {
          throw new Error(res.data.error || 'Unknown backend error');
      }

      setData(res.data);
      setMultiData(null);
      setDebugInfo(null);
      setMode('single');
      setTime(0);
      setPlaying(true);
    } catch (e) {
      const errorMsg = e.response?.data?.error || e.message;
      setError(`Simulation failed: ${errorMsg} (Check backend console for details)`);
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // --- FIX: Corrected Blob creation ---
  const downloadCSV = async () => {
    try {
      const res = await axios.post(`${BACKEND}/simulate_csv`, {
        ...config,
      }, { responseType: 'blob' });
      
      // FIX: res.data is already the blob. Don't wrap it in an array.
      const blob = new Blob([res.data], { type: res.headers['content-type'] });
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trace_${config.algorithm}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) {
      setError("CSV download failed.");
      console.error(e);
    }
  };
  // --- END FIX ---

  const maxT = useMemo(() => {
    if (mode === 'multi' && multiData) {
      let mMaxT = 0;
      for (const fid in multiData) {
        const tmax = lastOf(multiData[fid] || [])?.time || 0;
        if (tmax > mMaxT) mMaxT = tmax;
      }
      return mMaxT > 0 ? mMaxT : (config.duration || 0);
    }
    const singleMaxT = lastOf(data?.trace || [])?.time ?? (config.duration || 0);
    return singleMaxT > 0 ? singleMaxT : (config.duration || 0);
  }, [mode, data, multiData, config.duration]);

  useEffect(() => {
    if ((mode === 'single' && !data) || (mode ==='multi' && !multiData) || !playing) return;
    
    const dt = 0.1;
    const intervalMs = 100 / Math.max(speed, 0.1);
    
    const id = setInterval(() => {
      setTime(t => {
        const next = t + dt;
        if (next >= maxT) {
          setPlaying(false);
          return maxT;
        }
        return next;
      });
    }, intervalMs);
    
    return () => clearInterval(id);
  }, [maxT, playing, speed, mode, data, multiData]);

  const trace = data?.trace || [];
  
  const normalizedTrace = useMemo(() => trace.map(pt => ({
    time: pt.time ?? 0,
    cwnd: pt.cwnd ?? 0,
    throughput: pt.throughput ?? 0,
    buffer: pt.buffer ?? 0,
    inflight: pt.inflight ?? 0,
    sent: pt.sent ?? 0,
    delivered: pt.delivered ?? 0,
    dropped: pt.dropped ?? 0,
    phase: pt.phase ?? ''
  })), [trace]);

  const isNs3Data = useMemo(() => (normalizedTrace[0]?.phase === 'ns3'), [normalizedTrace]);
  const displayedTrace = useMemo(() => normalizedTrace.filter(p => p.time <= time), [normalizedTrace, time]);
  const currentSingle = displayedTrace.length ? displayedTrace[displayedTrace.length -1] : (normalizedTrace[0]||{buffer:0,inflight:0, phase: ''});
  const bufferPercentSingle = Math.min((currentSingle.buffer / Math.max(config.buffer,1)) * 100, 100);

  const queueChartDataKey = useMemo(() => isNs3Data ? 'buffer' : 'dropped', [isNs3Data]);
  const queueChartTitle = useMemo(() => isNs3Data ? 'Router Queue (packets)' : 'Packet Loss (cumulative dropped)', [isNs3Data]);
  const queueChartColor = useMemo(() => isNs3Data ? '#38bdf8' : '#ef4444', [isNs3Data]);


  const displayedMulti = useMemo(() => {
    if (!multiData) return null;
    const out = {};
    for (const fid in multiData) {
      const arr = multiData[fid] || [];
      out[fid] = arr.map(pt => ({
        time: pt.time ?? 0,
        cwnd: pt.cwnd ?? 0,
        throughput: pt.throughput ?? 0,
        buffer: pt.buffer ?? 0,
        inflight: pt.inflight ?? 0,
        sent: pt.sent ?? 0,
        delivered: pt.delivered ?? 0,
        dropped: pt.dropped ?? 0,
        dropped_cum: pt.dropped_cum ?? 0
      })).filter(p => p.time <= time);
    }
    return out;
  }, [multiData, time]);

  const reset = () => { setTime(0); setPlaying(false); };

  return (
    <div className="container">
      <h1>TCP Congestion Control Visualizer</h1>

      {error && (
        <div className="card" style={{ marginBottom: 16, padding: '10px 15px', backgroundColor: '#5e1b1b', border: '1px solid #ef4444' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="card" style={{marginBottom:16, display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', alignItems:'center', gap:12}}>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <strong>Engine:</strong>
          <select value={engine} onChange={e => setEngine(e.target.value)}>
            <option value="python">Python</option>
            <option value="ns3">ns-3</option>
          </select>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <strong>Mode:</strong>
          <button onClick={() => { setMode('single'); setMultiData(null); }}>Single Flow</button>
          <button onClick={() => { setMode('multi'); setData(null); }}>Multi Flow</button>
        </div>
        <div />
        
        <div style={{marginLeft:'auto', color:'#64748b', textAlign:'right'}}>
          {mode === 'single' && currentSingle && currentSingle.phase && (
            <strong style={{color: '#fff', textTransform: 'capitalize', display: 'block', fontSize: '1.1em', marginBottom: '4px'}}>
              {currentSingle.phase.replace('_', ' ')}
            </strong>
          )}
          t = {time.toFixed(1)}s / {maxT.toFixed(1)}s
        </div>
      </div>

      {mode === 'single' && (
        <>
          <div className="grid">
            <fieldset disabled={loading} className="card">
              <legend style={{padding: '0 5px'}}>
                <h2><Settings size={18}/> Settings</h2>
              </legend>
              <div className="input-group">
                <label>Algorithm</label>
                <select name="algorithm" value={config.algorithm} onChange={handleConfigChange}>
                  <option value="Reno">TCP Reno</option>
                  <option value="Cubic">TCP Cubic</option>
                  <option value="BBR">TCP BBR</option>
                </select>
              </div>
              <div className="input-group">
                <label>Link Bandwidth: {config.bandwidth} Mbps</label>
                <input name="bandwidth" type="range" min="1" max="200" value={config.bandwidth} onChange={handleConfigChange} />
              </div>
              <div className="input-group">
                <label>Router Buffer: {config.buffer} packets</label>
                <input name="buffer" type="range" min="5" max="500" value={config.buffer} onChange={handleConfigChange} />
              </div>
              <div className="input-group">
                <label>One-way Delay: {config.delay} ms (RTT {2*config.delay} ms)</label>
                <input name="delay" type="range" min="1" max="500" value={config.delay} onChange={handleConfigChange} />
              </div>
              <div className="input-group">
                <label>Duration: {config.duration}s</label>
                <input name="duration" type="range" min="5" max="120" value={config.duration} onChange={handleConfigChange} />
              </div>

              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10}}>
                <button onClick={runSim}>
                  {loading ? 'Running...' : (engine === 'ns3' ? 'Run (ns-3)' : 'Run (Python)')}
                </button>
                <button onClick={downloadCSV} disabled={!(data?.trace?.length)}><Download size={16}/> CSV</button>
              </div>
            </fieldset>

            <div className="card" style={{ display:'flex', alignItems:'center', justifyContent:'space-around' }}>
              <div style={{textAlign:'center'}}><Server size={40} color="#3b82f6"/><div>Sender</div></div>
              <div style={{textAlign:'center'}}>
                <div style={{width:30,height:80,border:'2px solid #64748b',background:'#0f172a',marginBottom:10,position:'relative',overflow:'hidden',borderRadius:6}}>
                  <div style={{position:'absolute',bottom:0,width:'100%',height:`${bufferPercentSingle}%`,background: bufferPercentSingle>90? '#ef4444' : '#eab308', transition:'height 0.1s linear'}}/>
                </div>
                <Router size={30} color="#94a3b8"/><div>Router</div>
              </div>
              <div style={{textAlign:'center'}}><Server size={40} color="#10b981"/><div>Receiver</div></div>
            </div>
          </div>
          
          <div className="card" style={{marginTop: 16}}>
            <div style={{display:'grid', gridTemplateColumns:'auto auto 1fr auto', gap:10, alignItems:'center'}}>
              <button onClick={()=>setPlaying(p=>!p)} disabled={!(data?.trace?.length)}>{playing ? <><Pause size={16}/> Pause</> : <><Play size={16}/> Play</>}</button>
              <button onClick={reset} disabled={!(data?.trace?.length)}><RotateCcw size={16}/> Reset</button>
              <input type="range" min="0" max={maxT} step="0.1" value={time} onChange={e=>setTime(parseFloat(e.target.value))} disabled={!(data?.trace?.length)}/>
              <select value={speed} onChange={e=>setSpeed(parseFloat(e.target.value))} disabled={!(data?.trace?.length)}>
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </div>
          </div>

          <AlgorithmInfoCard algorithm={config.algorithm} />

          {displayedTrace.length > 0 && (
            <>
              <DataChart
                title="Congestion Window (CWND)"
                data={displayedTrace}
                dataKey="cwnd"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                isArea={true}
                currentTime={time}
                height={300}
                style={{ marginTop: 20 }}
              />
              <DataChart
                title="Throughput (Mbps)"
                data={displayedTrace}
                dataKey="throughput"
                stroke="#10b981"
                currentTime={time}
                height={280}
                style={{ marginTop: 20 }}
              />
              <DataChart
                title="Inflight (packets)"
                data={displayedTrace}
                dataKey="inflight"
                stroke="#f97316"
                currentTime={time}
                height={220}
                style={{ marginTop: 12 }}
              />
              <DataChart
                title={queueChartTitle}
                data={displayedTrace}
                dataKey={queueChartDataKey}
                stroke={queueChartColor}
                currentTime={time}
                height={220}
                style={{ marginTop: 12 }}
              />
            </>
          )}
        </>
      )}

      {mode === 'multi' && (
        <>
          <TopologyBuilder
            backend={BACKEND}
            onResult={(tracesObj, debugObj) => {
              setMultiData(tracesObj || {});
              setDebugInfo(debugObj || null);
              setTime(0); setPlaying(true);
            }}
            onPlay={() => { setTime(0); setPlaying(true); }}
            onReset={() => { setTime(0); setPlaying(false); }}
          />

          {debugInfo && (
            <div className="card" style={{ marginTop: 12 }}>
              <strong>Backend debug</strong>
              <pre style={{ maxHeight:180, overflow:'auto', background:'#0f172a', padding: 8, borderRadius: 4 }}>{JSON.stringify(debugInfo, null, 2)}</pre>
            </div>
          )}

          {multiData && Object.entries(displayedMulti || {}).map(([fid, arr]) => {
            const displayed = arr || [];
            return (
              <div key={fid} style={{ marginTop:16 }}>
                <h2>Flow: {fid}</h2>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginTop:8 }}>
                  <DataChart
                    title="CWND"
                    data={displayed}
                    dataKey="cwnd"
                    stroke="#8b5cf6"
                    fill="#8b5cf6"
                    isArea={true}
                    currentTime={time}
                    height={260}
                  />
                  <DataChart
                    title="Throughput (Mbps)"
                    data={displayed}
                    dataKey="throughput"
                    stroke="#10b981"
                    currentTime={time}
                    height={260}
                  />
                  <DataChart
                    title="Inflight (packets)"
                    data={displayed}
                    dataKey="inflight"
                    stroke="#f97316"
                    currentTime={time}
                    height={220}
                  />
                  <DataChart
                    title="Cumulative Dropped (packets)"
                    data={displayed}
                    dataKey="dropped_cum"
                    stroke="#ef4444"
                    currentTime={time}
                    height={220}
                  />
                </div>
              </div>
            );
          })}

          {debugInfo && debugInfo.links && (
            <div style={{ marginTop:20 }}>
              <h3>Link Queue (packets) — per link</h3>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:12, marginTop:8 }}>
                {Object.entries(debugInfo.links).map(([lk, meta]) => {
                  const qhist = meta.queue_history || [];
                  const dt = Math.max(0.01, (config.duration || 1) / Math.max(qhist.length, 1));
                  const series = qhist.map((q, i) => ({ time: parseFloat((i * dt).toFixed(2)), queue: q }));
                  return (
                    <div key={lk} className="card" style={{ height:220 }}>
                      <h4 style={{marginBottom:6}}>{lk}</h4>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={series}>
                          <CartesianGrid stroke="#334155" opacity={0.2}/>
                          <XAxis dataKey="time" stroke="#94a3b8" />
                          <YAxis stroke="#94a3b8" />
                          <Tooltip />
                          <Line type="monotone" dataKey="queue" stroke="#60a5fa" dot={false} isAnimationActive={false}/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;