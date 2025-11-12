#include "ns3/core-module.h"
#include "ns3/network-module.h"
#include "ns3/internet-module.h"
#include "ns3/point-to-point-module.h"
#include "ns3/applications-module.h"
#include "ns3/traffic-control-module.h"
#include "ns3/tcp-socket-factory.h"
#include "ns3/tcp-l4-protocol.h"
#include "ns3/ipv4-global-routing-helper.h"
#include "ns3/config.h"

#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <map>

using namespace ns3;
NS_LOG_COMPONENT_DEFINE("tcp_multi_clean");

static std::vector<std::string> Split(const std::string& s, char d) {
  std::vector<std::string> out;
  std::stringstream ss(s);
  std::string x;
  while (std::getline(ss, x, d)) if (!x.empty()) out.push_back(x);
  return out;
}

struct FlowCtx {
  std::string algo;
  double mssBytes = 1500.0;
  double lastCwndBytes = 1500.0; 
  double inflightBytes = 0.0;    
  std::ofstream csv;
};

static std::map<uint32_t, uint64_t> gRxBytes, gRxBytesPrev;
static std::vector<Ptr<QueueDisc>> gQdiscs;

static void CwndTrace(FlowCtx* ctx, uint32_t /*oldCwnd*/, uint32_t newCwnd) {
  ctx->lastCwndBytes = static_cast<double>(newCwnd);
}
static void InflightTrace(FlowCtx* ctx, uint32_t /*oldVal*/, uint32_t newVal) {
  ctx->inflightBytes = static_cast<double>(newVal);
}
static void RxTrace(uint32_t idx, Ptr<const Packet> p, const Address &/*addr*/) {
  gRxBytes[idx] += p->GetSize();
}
static void DoSample(std::vector<FlowCtx>* pctx, double sampleDt) {
  uint32_t routerPkts = 0;
  for (const auto& qd : gQdiscs) {
    if (qd) routerPkts += qd->GetNPackets();
  }

  for (uint32_t i=0; i<pctx->size(); ++i) {
    uint64_t cur = gRxBytes[i], prev = gRxBytesPrev[i];
    gRxBytesPrev[i] = cur;
    uint64_t delta = (cur >= prev)? (cur - prev) : 0;
    double thrMbps = (delta * 8.0) / (sampleDt * 1e6);

    double cwndPkts = (*pctx)[i].lastCwndBytes / std::max(1.0, (*pctx)[i].mssBytes);
    double inflPkts = (*pctx)[i].inflightBytes / std::max(1.0, (*pctx)[i].mssBytes);

    (*pctx)[i].csv
      << Simulator::Now().GetSeconds() << ","
      << cwndPkts << ","
      << thrMbps << ","
      << routerPkts << ","
      << inflPkts << "\n";
  }

  Simulator::Schedule(Seconds(sampleDt), &DoSample, pctx, sampleDt);
}
static void HookSenderTraces(uint32_t senderId, FlowCtx* ctx) {
  std::ostringstream p1;
  p1 << "/NodeList/" << senderId
     << "/$ns3::TcpL4Protocol/SocketList/*/CongestionWindow";
  Config::ConnectWithoutContext(p1.str(), MakeBoundCallback(&CwndTrace, ctx));

  std::ostringstream p2;
  p2 << "/NodeList/" << senderId
     << "/$ns3::TcpL4Protocol/SocketList/*/BytesInFlight";
  Config::ConnectWithoutContext(p2.str(), MakeBoundCallback(&InflightTrace, ctx));
}

static TypeId ResolveTcpTypeId(const std::string& algo) {
  std::string ns3Name;
  if (algo == "Reno")      ns3Name = "ns3::TcpNewReno";
  else if (algo == "Cubic") ns3Name = "ns3::TcpCubic";
  else if (algo == "BBR")   ns3Name = "ns3::TcpBbr";
  else                      ns3Name = "ns3::TcpNewReno"; 

  TypeId tid;
  bool ok = TypeId::LookupByNameFailSafe(ns3Name, &tid);
  if (!ok) {
    if (ns3Name != "ns3::TcpNewReno") {
      NS_LOG_WARN(ns3Name << " not available; falling back to ns3::TcpNewReno.");
      ok = TypeId::LookupByNameFailSafe("ns3::TcpNewReno", &tid);
    }
    if (!ok) {
      NS_FATAL_ERROR("Could not resolve TCP TypeId for " << ns3Name << " or fallback TcpNewReno");
    }
  }
  return tid;
}

int main (int argc, char *argv[]) {
  std::string flows = "Reno,Cubic";
  std::string rate  = "5Mbps";
  std::string delay = "50ms";
  std::string qdiscType = "ns3::FifoQueueDisc";
  uint32_t bufferPkts = 20;
  uint32_t duration = 20;
  uint32_t mss = 1500;
  double sampleDt = 0.1;

  CommandLine cmd(__FILE__);
  cmd.AddValue("flows", "Comma list of TCP variants (Reno,Cubic,BBR,...)", flows);
  cmd.AddValue("rate", "Bottleneck rate (e.g., 5Mbps)", rate);
  cmd.AddValue("delay","One-way propagation delay (e.g., 50ms)", delay);
  cmd.AddValue("bufferPkts","Router queue size in packets", bufferPkts);
  cmd.AddValue("duration","Simulation time (s)", duration);
  cmd.AddValue("mss","MSS bytes", mss);
  cmd.AddValue("sampleDt","Sampler period (s)", sampleDt);
  cmd.AddValue("qdisc","Root queue disc TypeId (e.g., ns3::FifoQueueDisc, ns3::CoDelQueueDisc)", qdiscType);
  cmd.Parse(argc, argv);

  Config::SetDefault("ns3::TcpSocket::SegmentSize", UintegerValue(mss));
  Config::SetDefault("ns3::TcpSocket::RcvBufSize", UintegerValue(4 * 1024 * 1024));
  Config::SetDefault("ns3::TcpSocket::SndBufSize", UintegerValue(4 * 1024 * 1024));

  TrafficControlHelper tch;
  tch.SetRootQueueDisc(qdiscType.c_str(),
                       "MaxSize", StringValue(std::to_string(bufferPkts) + "p"));

  auto algos = Split(flows, ',');
  uint32_t n = std::max<uint32_t>(algos.size(), 1);

  NodeContainer senders, router, receivers;
  senders.Create(n);
  router.Create(1);
  receivers.Create(n);

  InternetStackHelper stack;
  stack.Install(senders);
  stack.Install(router);
  stack.Install(receivers);

  PointToPointHelper p2pUp;
  p2pUp.SetDeviceAttribute("DataRate", StringValue("100Mbps")); 
  p2pUp.SetChannelAttribute("Delay", StringValue("1ms"));

  PointToPointHelper p2pDown; 
  p2pDown.SetDeviceAttribute("DataRate", StringValue(rate));
  p2pDown.SetChannelAttribute("Delay", StringValue(delay));

  std::vector<NetDeviceContainer> sr(n), rr(n);
  for (uint32_t i=0;i<n;i++) {
    sr[i] = p2pUp.Install(senders.Get(i), router.Get(0));
    rr[i] = p2pDown.Install(router.Get(0), receivers.Get(i));
    NetDeviceContainer routerOnly(rr[i].Get(0));
    QueueDiscContainer qdc = tch.Install(routerOnly);
    gQdiscs.push_back(qdc.Get(0));
  }

  Ipv4AddressHelper addr;
  std::vector<Ipv4InterfaceContainer> isr(n), irr(n);
  for (uint32_t i=0;i<n;i++) {
    std::ostringstream net1; net1<<"10.1."<<(i+1)<<".0";
    addr.SetBase(net1.str().c_str(),"255.255.255.0");
    isr[i] = addr.Assign(sr[i]);
    std::ostringstream net2; net2<<"10.2."<<(i+1)<<".0";
    addr.SetBase(net2.str().c_str(),"255.255.255.0");
    irr[i] = addr.Assign(rr[i]);
  }
  Ipv4GlobalRoutingHelper::PopulateRoutingTables();

  // sinks + senders
  std::vector<uint16_t> ports(n);
  for (uint32_t i=0;i<n;i++) {
    ports[i] = 5000 + i;

    // Sink
    PacketSinkHelper sinkHelper("ns3::TcpSocketFactory",
                                InetSocketAddress(Ipv4Address::GetAny(), ports[i]));
    auto sinkApps = sinkHelper.Install(receivers.Get(i));
    sinkApps.Start(Seconds(0.0));
    sinkApps.Stop(Seconds(duration));

    Ptr<PacketSink> sink = DynamicCast<PacketSink>(sinkApps.Get(0));
    sink->TraceConnectWithoutContext("Rx", MakeBoundCallback(&RxTrace, i));

    BulkSendHelper bsh("ns3::TcpSocketFactory",
                       InetSocketAddress(irr[i].GetAddress(1), ports[i]));
    bsh.SetAttribute("MaxBytes", UintegerValue(0));
    auto apps = bsh.Install(senders.Get(i));
    apps.Start(Seconds(0.1));
    apps.Stop(Seconds(duration));
  }

  std::vector<FlowCtx> ctx(n);
  for (uint32_t i=0;i<n;i++) {
    ctx[i].algo = (i < algos.size()) ? algos[i] : algos.back();
    ctx[i].mssBytes = static_cast<double>(mss);

    TypeId tid = ResolveTcpTypeId(ctx[i].algo);

    uint32_t senderId = senders.Get(i)->GetId();
    std::string base = "/NodeList/" + std::to_string(senderId) + "/$ns3::TcpL4Protocol/SocketType";
    Config::Set(base, TypeIdValue(tid));

    std::ostringstream fn; fn << "trace_flow" << i << ".csv";
    ctx[i].csv.open(fn.str(), std::ios::out);
    if (!ctx[i].csv) {
      NS_FATAL_ERROR("Failed to open CSV for flow " << i);
    }
    ctx[i].csv << "time,cwnd_pkts,throughput_mbps,buffer_pkts,inflight_pkts\n";

    Simulator::Schedule(Seconds(0.11), &HookSenderTraces, senderId, &ctx[i]);
  }

  Simulator::Schedule(Seconds(sampleDt), &DoSample, &ctx, sampleDt);

  Simulator::Stop(Seconds(duration));
  Simulator::Run();
  Simulator::Destroy();

  for (auto &c : ctx) if (c.csv.is_open()) c.csv.close();
  std::cerr << "--- HELLO, I AM THE NEW EXECUTABLE ---" << std::endl;
  return 0;
}