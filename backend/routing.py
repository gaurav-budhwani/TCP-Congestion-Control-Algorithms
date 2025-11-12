import heapq

def build_topology_graph(topology_name, default_link):
    # build graphs in the multi flow tab
    links = {}
    graph = {}

    def add_link(a, b, params=None):
        key = f"{a}-{b}"
        params = dict(params or default_link)
        links[key] = dict(params)
        graph.setdefault(a, {})[b] = key
        graph.setdefault(b, {})[a] = key

    topo = (topology_name or 'parallel').lower()
    if topo == 'single':
        add_link('N0', 'R', default_link)
        add_link('R', 'N1', default_link)
    elif topo == 'parallel':
        add_link('N0', 'R1', default_link)
        add_link('R1', 'N1', default_link)
        add_link('N0', 'R2', default_link)
        add_link('R2', 'N1', default_link)
    elif topo == 'series':
        add_link('N0', 'R1', default_link)
        add_link('R1', 'R2', default_link)
        add_link('R2', 'N1', default_link)
    elif topo == 'triangle':
        add_link('N0', 'R1', default_link)
        add_link('N0', 'R2', default_link)
        add_link('R1', 'R2', default_link)
        add_link('R1', 'N1', default_link)
        add_link('R3', 'N2', default_link)
    else:
        # fallback to parallel
        add_link('N0', 'R1', default_link)
        add_link('R1', 'N1', default_link)
        add_link('N0', 'R2', default_link)
        add_link('R2', 'N1', default_link)

    return links, graph

def link_cost_fn_factory(links, alpha_delay=1.0, beta_inv_bw=100.0):
    # cost = alpha * delay_ms + beta * (1 / bandwidth_Mbps)
    def cost_func(linkKey):
        lk = links[linkKey]
        delay = float(lk.get('delay', 15.0))
        bw = float(lk.get('bandwidth', 1.0))
        return alpha_delay * delay + beta_inv_bw * (1.0 / max(0.001, bw))
    return cost_func

def dijkstra_path(graph, start, goal, cost_fn):
    pq = [(0.0, start, [])]
    best = {}
    while pq:
        cost, node, path = heapq.heappop(pq)
        if node == goal:
            return path + [node]
        if node in best and best[node] <= cost:
            continue
        best[node] = cost
        for nbr, linkKey in graph.get(node, {}).items():
            new_cost = cost + cost_fn(linkKey)
            heapq.heappush(pq, (new_cost, nbr, path + [node]))
    return None

def path_nodes_to_linkkeys(path_nodes, graph):
    link_keys = []
    if not path_nodes or len(path_nodes) < 2:
        return link_keys
    for i in range(len(path_nodes) - 1):
        a = path_nodes[i]; b = path_nodes[i+1]
        lk = graph[a].get(b)
        if not lk:
            return None
        link_keys.append(lk)
    return link_keys

def choose_paths_for_flows(graph, links, flows):
    cost_fn = link_cost_fn_factory(links)
    paths = {}
    for f in flows:
        fid = f.get('id') or f"{f.get('src','N0')}-{f.get('dst','N1')}"
        src = f.get('src', 'N0')
        dst = f.get('dst', 'N1')
        node_path = dijkstra_path(graph, src, dst, cost_fn)
        if node_path is None:
            paths[fid] = []
            continue
        linkkeys = path_nodes_to_linkkeys(node_path, graph) or []
        paths[fid] = linkkeys
    return paths
