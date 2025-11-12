import React, { useMemo, useState, useEffect } from "react";
import axios from "axios";
import { X } from 'lucide-react';

export default function TopologyBuilder({ backend, onResult, onPlay, onReset }) {
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
    return `${prefix}${i}`;
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
                  {/* Flow ID is now simple */}
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

                return elems.reverse();
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