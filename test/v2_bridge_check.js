// v2 bridge verification: helmet-link semantics, fallback, demote/restore
import { StateManager } from '../src/server/stateManager.js';
import { Node1Bridge } from '../src/server/node1Bridge.js';

const sm = new StateManager();
const bridge = new Node1Bridge(sm, '192.168.14.60', 1500);
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// ---- Scenario 1: v2 firmware, stations alive, helmet ABSENT ----
// gateway heard from N2/N3 stations only; heartbeats report helmet_link=false
const v2 = {
  system: { active_route: '', overall_risk_index: 'LOW' },
  miner: { worker_id: 'MINER 01', status: 'OFFLINE_CASUALTY', motion_state: 'STATIONARY', step_count: 0, total_distance_m: 0, heading_deg: 0 },
  environment: { temperature_c: 25, humidity_pct: 50, mq4_methane_ppm: 0, mq6_lpg_ppm: 0, mq8_hydrogen_ppm: 0 },
  mesh_topology: {
    node2_relay: { online: true, rssi_dbm: -70, snr_db: 9.5, distance_to_helmet_m: 0, distance_to_node3_m: 2.1, hazard_level: 0, hazard_status: 'STABLE', helmet_link: false, helmet_rssi_db: null, helmet_snr_db: null },
    node3_relay: { online: true, rssi_dbm: -68, snr_db: 10.2, distance_to_helmet_m: 0, hazard_level: 0, hazard_status: 'STABLE', helmet_link: false, helmet_rssi_db: null, helmet_snr_db: null, peer_rssi_db: -66.5, peer_snr_db: 11.0 },
    helmet_direct: { online: false, rssi_dbm: 0, snr_db: 0, distance_to_helmet_m: -1.0 },
    tunnel_position: { nearest_node: 'NODE02', relative_slider_pct: 50 }
  }
};
bridge.translate(v2);
const nodes = Object.fromEntries(sm.nodes.map(n => [n.id, n]));
const links = Object.fromEntries(sm.links.map(l => [l.id, l]));
check('S1 NODE01 ONLINE (gateway synced)', nodes.NODE01.status === 'ONLINE');
check('S1 NODE02 ONLINE (station alive)', nodes.NODE02.status === 'ONLINE');
check('S1 NODE03 ONLINE (station alive)', nodes.NODE03.status === 'ONLINE');
check('S1 HELMET01 OFFLINE', nodes.HELMET01.status === 'OFFLINE');
check('S1 helmet->N2 DISCONNECTED', links.link_helmet_node02.status === 'DISCONNECTED');
check('S1 helmet->N3 DISCONNECTED', links.link_helmet_node03.status === 'DISCONNECTED');
check('S1 helmet->N2 rssi -100 when down', links.link_helmet_node02.rssi === -100);
check('S1 N3->N2 CONNECTED', links.link_node03_node02.status === 'CONNECTED');
check('S1 N3->N2 uses true peer RSSI', links.link_node03_node02.rssi === -66.5, `got ${links.link_node03_node02.rssi}`);
check('S1 N3->N2 uses true peer SNR', links.link_node03_node02.snr === 11.0, `got ${links.link_node03_node02.snr}`);
check('S1 bypass CONNECTED (N3 alive)', links.link_node03_node01.status === 'CONNECTED');
check('S1 bypass keeps config rssi', links.link_node03_node01.rssi === -79, `got ${links.link_node03_node01.rssi}`);

// ---- Scenario 2: v2 firmware, helmet alive VIA RELAY ONLY (deep tunnel) ----
const v2b = JSON.parse(JSON.stringify(v2));
v2b.mesh_topology.node2_relay.helmet_link = true;
v2b.mesh_topology.node2_relay.helmet_rssi_db = -72.4;
v2b.mesh_topology.node2_relay.helmet_snr_db = 8.75;
v2b.mesh_topology.node2_relay.distance_to_helmet_m = 1.6;
v2b.mesh_topology.node3_relay.helmet_link = false;
v2b.miner.status = 'SAFE';
bridge.translate(v2b);
const links2 = Object.fromEntries(sm.links.map(l => [l.id, l]));
const nodes2 = Object.fromEntries(sm.nodes.map(n => [n.id, n]));
check('S2 HELMET01 ONLINE via relay liveness', nodes2.HELMET01.status === 'ONLINE');
check('S2 helmet->N2 CONNECTED (relay-only)', links2.link_helmet_node02.status === 'CONNECTED');
check('S2 helmet->N2 true helmet RSSI', links2.link_helmet_node02.rssi === -72.4, `got ${links2.link_helmet_node02.rssi}`);
check('S2 helmet->N2 true helmet SNR', links2.link_helmet_node02.snr === 8.75, `got ${links2.link_helmet_node02.snr}`);
check('S2 helmet->N1 DISCONNECTED (not direct)', links2.link_helmet_node01.status === 'DISCONNECTED');
check('S2 helmet->N3 DISCONNECTED (N3 hears nothing)', links2.link_helmet_node03.status === 'DISCONNECTED');

// ---- Scenario 3: OLD firmware fallback (no v2 fields) ----
const old = {
  system: { active_route: '', overall_risk_index: 'LOW' },
  miner: { worker_id: 'MINER 01', status: 'SAFE', motion_state: 'STATIONARY', step_count: 5, total_distance_m: 3.5, heading_deg: 90 },
  environment: { temperature_c: 30, humidity_pct: 60, mq4_methane_ppm: 100, mq6_lpg_ppm: 110, mq8_hydrogen_ppm: 120 },
  mesh_topology: {
    node2_relay: { online: true, rssi_dbm: -65, snr_db: 9.0, distance_to_helmet_m: 22.5, distance_to_node3_m: 15.0, hazard_level: 0, hazard_status: 'STABLE' },
    node3_relay: { online: true, rssi_dbm: -55, snr_db: 10.0, distance_to_helmet_m: 5.2, hazard_level: 0, hazard_status: 'STABLE' },
    helmet_direct: { online: true, rssi_dbm: -58, snr_db: 9.5, distance_to_helmet_m: 3.5 },
    tunnel_position: { nearest_node: 'NODE03', relative_slider_pct: 65 }
  }
};
bridge.translate(old);
const links3 = Object.fromEntries(sm.links.map(l => [l.id, l]));
check('S3 helmet->N2 CONNECTED (legacy logic)', links3.link_helmet_node02.status === 'CONNECTED');
check('S3 helmet->N2 falls back to trunk RSSI', links3.link_helmet_node02.rssi === -65, `got ${links3.link_helmet_node02.rssi}`);
check('S3 helmet->N2 falls back to trunk SNR', links3.link_helmet_node02.snr === 9.0, `got ${links3.link_helmet_node02.snr}`);
check('S3 N3->N2 falls back to trunk RSSI', links3.link_node03_node02.rssi === -55, `got ${links3.link_node03_node02.rssi}`);

// ---- Scenario 4: poll-failure demotion + restore ----
bridge.consecutiveFailures = 3;
bridge._demoteAllNodes();
const nodes4 = Object.fromEntries(sm.nodes.map(n => [n.id, n]));
const links4 = Object.fromEntries(sm.links.map(l => [l.id, l]));
check('S4 all nodes OFFLINE after demote', sm.nodes.every(n => n.status === 'OFFLINE'));
check('S4 all links DISCONNECTED after demote', sm.links.every(l => l.status === 'DISCONNECTED'));
check('S4 demoted flag set', bridge.demoted === true);
const demoteEvent = sm.events.slice(0, 5).find(e => e.severity === 'WARNING' && e.message.includes('unreachable'));
check('S4 WARNING event emitted', Boolean(demoteEvent));
bridge.translate(old); // next successful poll restores
const nodes5 = Object.fromEntries(sm.nodes.map(n => [n.id, n]));
check('S4 NODE02 restored by next poll', nodes5.NODE02.status === 'ONLINE');
const links5 = Object.fromEntries(sm.links.map(l => [l.id, l]));
check('S4 helmet->N3 restored by next poll', links5.link_helmet_node03.status === 'CONNECTED');

console.log(`\n${pass} passed, ${fail} failed`);
sm.destroy();
process.exit(fail > 0 ? 1 : 0);
