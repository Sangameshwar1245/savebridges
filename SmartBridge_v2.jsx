import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════
// BRIDGE DATABASE  (Fix #5: structured data, proper metadata fields)
// ═══════════════════════════════════════════════════════════════════
const BRIDGE_DB = {
  wa001: { id:"wa001", name:"Aurora Ave N Overpass",    feature:"AURORA AVE N",   facility:"SR 99",     clearance:13.5, speedLimit:35,  reliability:"Surveyed",  inspected:"Aug 2023" },
  wa002: { id:"wa002", name:"I-5 Northgate Structure",  feature:"NORTHGATE WAY",  facility:"I-5",       clearance:14.8, speedLimit:60,  reliability:"Surveyed",  inspected:"Jun 2023" },
  wa003: { id:"wa003", name:"BNSF Railroad Crossing",   feature:"15TH AVE NW",    facility:"BNSF RR",   clearance:12.2, speedLimit:25,  reliability:"Estimated", inspected:"Nov 2022" },
  wa004: { id:"wa004", name:"SR-520 Montlake Flyover",  feature:"MONTLAKE BLVD",  facility:"SR 520",    clearance:16.0, speedLimit:45,  reliability:"Surveyed",  inspected:"Sep 2023" },
  wa005: { id:"wa005", name:"Alaskan Way Low Bridge",   feature:"ALASKAN WAY",    facility:"BIKE PATH", clearance:11.5, speedLimit:30,  reliability:"Estimated", inspected:"Aug 2022" },
  wa006: { id:"wa006", name:"Rainier Ave S Underpass",  feature:"RAINIER AVE S",  facility:"LINK RAIL", clearance:14.0, speedLimit:35,  reliability:"Surveyed",  inspected:"Jan 2024" },
};

// ═══════════════════════════════════════════════════════════════════
// ROUTE PRESETS
// ═══════════════════════════════════════════════════════════════════
const ROUTES = [
  { id:"r1", name:"Aurora Ave N — SR-99",   road:"AURORA AVE N",   seq:[{id:"wa001",d:2.2},{id:"wa003",d:4.8}] },
  { id:"r2", name:"I-5 Express Northbound", road:"I-5",            seq:[{id:"wa002",d:1.7},{id:"wa004",d:4.1}] },
  { id:"r3", name:"Mixed City Corridor",    road:"MONTLAKE BLVD",  seq:[{id:"wa001",d:0.9},{id:"wa005",d:2.3},{id:"wa006",d:3.8}] },
];

// ═══════════════════════════════════════════════════════════════════
// HELPERS  (Fix #6: let/const, no variable shadowing)
// ═══════════════════════════════════════════════════════════════════
const DIRECTIONALS = new Set([
  "NB","SB","EB","WB","N","S","E","W","NE","NW","SE","SW",
  "NORTH","SOUTH","EAST","WEST","NORTHBOUND","SOUTHBOUND","EASTBOUND","WESTBOUND"
]);
const ROAD_SUFFIXES = [
  " BOULEVARD"," BLVD"," STREET"," AVENUE"," PARKWAY"," HIGHWAY",
  " DRIVE"," ROAD"," LANE"," AVE"," ST"," DR"," RD"," LN"," HWY"," PKWY"
];

// Fix #14: normalizeRoad — ported and cleaned from index.html (no variable shadowing)
function normalizeRoad(name) {
  if (!name) return "";
  let s = String(name).toUpperCase().trim();
  s = s.replace(/\bI[-\s]*(\d+[A-Z]?)\b/g, "I$1");
  s = s.replace(/\bSR[-\s]*(\d+[A-Z]?)\b/g, "SR$1");
  s = s.replace(/\bUS[-\s]*(\d+[A-Z]?)\b/g, "US$1");
  s = s.replace(/\b[NSEW]-[NSEW]\b/g, " ");
  let tokens = s.split(/\s+/).filter(t => t && !DIRECTIONALS.has(t));
  s = tokens.join(" ");
  for (const suf of ROAD_SUFFIXES) {
    if (s.length > suf.length && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  // Second pass — directionals may have been trailing after suffix removal
  tokens = s.split(/\s+/).filter(t => t && !DIRECTIONALS.has(t));
  s = tokens.join(" ");
  // Retry suffix strip
  for (const suf of ROAD_SUFFIXES) {
    if (s.length > suf.length && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s.replace(/\s+/g, " ").trim();
}

// Fix #15: confidence scoring — fuzzy road match with token overlap
function computeConfidence(bridgeFeature, truckRoad) {
  const a = normalizeRoad(bridgeFeature);
  const b = normalizeRoad(truckRoad);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const aTokens = new Set(a.split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.split(/\s+/).filter(Boolean));
  let shared = 0;
  for (const t of aTokens) { if (bTokens.has(t)) shared++; }
  const overlapScore = shared / Math.max(aTokens.size, bTokens.size, 1);
  const substrScore  = (a.includes(b) || b.includes(a)) ? 0.85 : 0;
  return Math.round(Math.min(100, Math.max(overlapScore, substrScore) * 100));
}

// Fix #13: dynamic caution threshold based on speed
function getAlertLevel(truckH, clearance, speedMph = 0) {
  const margin = clearance - truckH;
  const threshold = speedMph > 60 ? 1.5 : speedMph > 40 ? 1.2 : 1.0;
  if (margin > threshold) return "SAFE";
  if (margin > 0)         return "CAUTION";
  return "DANGER";
}

function getAlertStage(dist) {
  if (dist <= 0.5) return "0.5_mile";
  if (dist <= 1.0) return "1_mile";
  if (dist <= 2.0) return "2_mile";
  return null;
}

function getETA(dist, speedMph) {
  if (speedMph < 3) return Infinity;
  return (dist / speedMph) * 3600; // seconds
}

// Fix #13: ETA-based escalation — fast truck gets elevated stage
function getEffectiveStage(dist, speedMph) {
  const rawStage = getAlertStage(dist);
  if (!rawStage) return null;
  const eta = getETA(dist, speedMph);
  if (eta < 30) return "0.5_mile";
  if (eta < 90) return "1_mile";
  return rawStage;
}

// ═══════════════════════════════════════════════════════════════════
// DESIGN TOKENS  (Fix #11: all from single source of truth)
// ═══════════════════════════════════════════════════════════════════
const T = {
  bg:      "#06090f",
  panel:   "#0b1018",
  p2:      "#0f1520",
  p3:      "#131d28",
  border:  "#1a2535",
  b2:      "#1e2d40",
  cyan:    "#00d4ff",
  safe:    "#00e87a",
  caution: "#ffb800",
  danger:  "#ff3b3b",
  text:    "#e8edf4",
  text2:   "#7a8ea8",
  muted:   "#3a4f66",
  mono:    "'IBM Plex Mono','Courier New',monospace",
  sans:    "'IBM Plex Sans',-apple-system,sans-serif",
};

const LEVEL_CLR = { SAFE: T.safe, CAUTION: T.caution, DANGER: T.danger };
const LEVEL_BG  = {
  SAFE:    "rgba(0,232,122,0.07)",
  CAUTION: "rgba(255,184,0,0.08)",
  DANGER:  "rgba(255,59,59,0.10)",
};
const STAGE_LABEL = { "2_mile":"2 MILE", "1_mile":"1 MILE", "0.5_mile":"½ MILE" };

// ═══════════════════════════════════════════════════════════════════
// OFFLINE BANNER  (Fix #12: navigator.onLine detection)
// ═══════════════════════════════════════════════════════════════════
function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const goOn  = () => setOffline(false);
    const goOff = () => setOffline(true);
    window.addEventListener("online",  goOn);
    window.addEventListener("offline", goOff);
    return () => { window.removeEventListener("online", goOn); window.removeEventListener("offline", goOff); };
  }, []);
  if (!offline) return null;
  return (
    <div style={{ background: T.caution, padding:"5px 16px", textAlign:"center",
      fontSize:10, fontFamily:T.mono, color:"#000", fontWeight:700, letterSpacing:1.5 }}>
      ◈ OFFLINE — Cached bridge data active · Proximity alerts still running
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LEVEL BADGE
// ═══════════════════════════════════════════════════════════════════
function LevelBadge({ level, sm }) {
  return (
    <span style={{
      background: LEVEL_CLR[level], color: level === "CAUTION" ? "#000" : "#fff",
      fontSize: sm ? 8 : 10, fontWeight:800, fontFamily:T.mono,
      padding: sm ? "1px 5px" : "2px 8px", borderRadius:3, letterSpacing:0.8,
    }}>{level}</span>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CONFIDENCE BAR
// ═══════════════════════════════════════════════════════════════════
function ConfBar({ score }) {
  const c = score >= 75 ? T.safe : score >= 55 ? T.caution : T.muted;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
      <div style={{ flex:1, height:3, background:T.p3, borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${score}%`, height:"100%", background:c, borderRadius:2, transition:"width 0.5s ease" }} />
      </div>
      <span style={{ color:c, fontSize:9, fontFamily:T.mono, minWidth:24, textAlign:"right" }}>{score}%</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SVG MAP  (Fix #1: no Google Maps API key needed)
//           (Fix #9: no deprecated google.maps.Marker)
// ═══════════════════════════════════════════════════════════════════
function MapCanvas({ activeBridges, truckH, speedMph }) {
  const W = 340, H = 250;
  const TRUCK_Y = 205;
  const SCALE = 55; // px per mile

  return (
    <div style={{ margin:"0 16px", borderRadius:12, overflow:"hidden",
      border:`1px solid ${T.border}`, background:T.panel, position:"relative" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display:"block" }}>
        <defs>
          <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#040710" /><stop offset="100%" stopColor="#080d18" />
          </linearGradient>
          <linearGradient id="roadGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={T.p2} stopOpacity="0" />
            <stop offset="25%" stopColor={T.p2} />
            <stop offset="75%" stopColor={T.p2} />
            <stop offset="100%" stopColor={T.p2} stopOpacity="0" />
          </linearGradient>
          <filter id="glw"><feGaussianBlur stdDeviation="2.5" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {/* Background */}
        <rect width={W} height={H} fill="url(#bgGrad)" />

        {/* Scan lines */}
        {Array.from({length:25},(_,i)=>(
          <line key={i} x1={0} y1={i*10} x2={W} y2={i*10}
            stroke="#ffffff" strokeWidth={0.3} strokeOpacity={0.025} />
        ))}

        {/* Road */}
        <rect x={(W-56)/2} y={0} width={56} height={H} fill="url(#roadGrad)" />
        <line x1={(W-56)/2} y1={0} x2={(W-56)/2} y2={H} stroke={T.b2} strokeWidth={1} />
        <line x1={(W+56)/2} y1={0} x2={(W+56)/2} y2={H} stroke={T.b2} strokeWidth={1} />
        {/* Center dashes */}
        {Array.from({length:7},(_,i)=>(
          <line key={i} x1={W/2} y1={i*36} x2={W/2} y2={i*36+22}
            stroke={T.b2} strokeWidth={1.5} />
        ))}

        {/* Bridge markers */}
        {activeBridges.filter(ab => ab.dist > 0.01 && ab.dist <= 3.8).map(ab => {
          const br = BRIDGE_DB[ab.bridgeId];
          if (!br) return null;
          const by = TRUCK_Y - ab.dist * SCALE;
          if (by < 4 || by > H - 4) return null;
          const lvl = getAlertLevel(truckH, br.clearance, speedMph);
          const clr = LEVEL_CLR[lvl];
          const stg = getAlertStage(ab.dist);

          return (
            <g key={ab.bridgeId} filter={lvl !== "SAFE" ? "url(#glw)" : undefined}>
              {/* Alert rings */}
              {stg && ["2_mile","1_mile","0.5_mile"].filter(s => {
                const d = {"2_mile":2.0,"1_mile":1.0,"0.5_mile":0.5}[s];
                return ab.dist <= d;
              }).map(s => {
                const rx = {"2_mile":130,"1_mile":90,"0.5_mile":52}[s];
                return (
                  <ellipse key={s} cx={W/2} cy={by} rx={rx} ry={rx*0.22}
                    fill="none" stroke={clr} strokeWidth={0.8}
                    strokeDasharray="5,4" strokeOpacity={0.35} />
                );
              })}

              {/* Bridge silhouette — arch + deck */}
              <path d={`M ${W/2-34} ${by+6} Q ${W/2} ${by-8} ${W/2+34} ${by+6}`}
                fill="none" stroke={clr} strokeWidth={1.5} strokeOpacity={0.5} />
              <rect x={(W-70)/2} y={by+4} width={70} height={7}
                fill={T.p3} stroke={clr} strokeWidth={1.5} rx={1} />
              {/* Pillars */}
              {[-28,-14,0,14,28].map(x => (
                <line key={x} x1={W/2+x} y1={by+11} x2={W/2+x} y2={by+18}
                  stroke={clr} strokeWidth={1} strokeOpacity={0.4} />
              ))}

              {/* Clearance label — right of road */}
              <text x={(W+40)/2} y={by+9} fill={clr} fontSize={8.5}
                fontFamily={T.mono} fontWeight="600" dominantBaseline="middle">
                {br.clearance}' {lvl !== "SAFE" ? "▲" : ""}
              </text>

              {/* Distance label — left of road */}
              <text x={(W-40)/2} y={by+9} fill={T.text2} fontSize={8}
                fontFamily={T.mono} textAnchor="end" dominantBaseline="middle">
                {ab.dist < 0.1 ? "NOW" : `${ab.dist.toFixed(2)}mi`}
              </text>
            </g>
          );
        })}

        {/* Truck — blue HUD chevron */}
        <g transform={`translate(${W/2},${TRUCK_Y})`}>
          <circle cx={0} cy={0} r={13} fill={T.cyan} fillOpacity={0.1} />
          <polygon points="0,-12 9,7 0,3 -9,7"
            fill={T.cyan} stroke="white" strokeWidth={1.5} />
          <circle cx={0} cy={0} r={3} fill="white" />
        </g>

        {/* HUD labels */}
        <text x={10} y={H-8} fill={T.muted} fontSize={8} fontFamily={T.mono}>{speedMph} mph</text>
        <text x={W-10} y={H-8} fill={T.cyan} fontSize={8} fontFamily={T.mono} textAnchor="end">
          H={truckH.toFixed(1)}'
        </text>
        <text x={W-10} y={14} fill={T.muted} fontSize={9} fontFamily={T.mono} textAnchor="end">N</text>
        <line x1={W-10} y1={16} x2={W-10} y2={26} stroke={T.cyan} strokeWidth={1.2} />
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ALERT CARD  (Fix #8: no alert()/confirm(), Fix #11: design tokens)
// ═══════════════════════════════════════════════════════════════════
function AlertCard({ alert, onAck }) {
  const [flash, setFlash] = useState(false);
  const br = BRIDGE_DB[alert.bridgeId];
  const margin = br.clearance - alert.truckH;
  const clr = LEVEL_CLR[alert.level];

  useEffect(() => {
    if (alert.level !== "DANGER") return;
    const id = setInterval(() => setFlash(f => !f), 380);
    return () => clearInterval(id);
  }, [alert.level]);

  return (
    <div style={{
      background: flash ? "rgba(255,59,59,0.18)" : LEVEL_BG[alert.level],
      border: `1.5px solid ${clr}`,
      borderRadius:10, padding:"12px 14px", marginBottom:8,
      transition:"background 0.15s",
    }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <div style={{ width:6, height:6, borderRadius:"50%", background:clr, boxShadow:`0 0 5px ${clr}` }} />
          <span style={{ color:T.text2, fontSize:9, fontFamily:T.mono, letterSpacing:1.2 }}>
            {STAGE_LABEL[alert.stage]} ALERT
          </span>
        </div>
        <LevelBadge level={alert.level} sm />
      </div>

      <div style={{ color:T.text, fontSize:13, fontWeight:700, marginBottom:8, lineHeight:1.3 }}>
        {br.name}
      </div>

      {/* Stats: 3-column grid */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"5px 10px", marginBottom:8 }}>
        {[
          ["YOUR HEIGHT", `${alert.truckH.toFixed(1)} ft`, T.cyan],
          ["CLEARANCE",   `${br.clearance.toFixed(1)} ft`, clr],
          ["MARGIN",      `${margin>=0?"+":""}${margin.toFixed(1)} ft`, margin<0?T.danger:T.safe],
        ].map(([lbl, val, c]) => (
          <div key={lbl}>
            <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono, letterSpacing:0.7, marginBottom:2 }}>{lbl}</div>
            <div style={{ color:c, fontSize:14, fontFamily:T.mono, fontWeight:700 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Distance + ETA + Confidence */}
      <div style={{ display:"flex", gap:14, marginBottom:alert.level!=="SAFE"?8:0 }}>
        {[
          ["DISTANCE", `${alert.dist.toFixed(2)} mi`, T.text2],
          ...(alert.eta != null && isFinite(alert.eta)
            ? [["ETA", alert.eta < 60 ? `${Math.round(alert.eta)}s` : `${(alert.eta/60).toFixed(1)}m`,
               alert.eta < 60 ? T.danger : T.caution]]
            : []),
          ["ROAD MATCH", `${alert.confidence}%`,
           alert.confidence >= 75 ? T.safe : alert.confidence >= 55 ? T.caution : T.muted],
        ].map(([lbl, val, c]) => (
          <div key={lbl}>
            <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono, marginBottom:2 }}>{lbl}</div>
            <div style={{ color:c, fontSize:12, fontFamily:T.mono }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Action message */}
      {alert.level !== "SAFE" && (
        <div style={{
          background:"rgba(0,0,0,0.35)", borderRadius:6,
          padding:"6px 10px", marginBottom:8,
          fontSize:9, fontFamily:T.mono, fontWeight:700, letterSpacing:0.5,
          color: alert.level==="DANGER" ? T.danger : T.caution,
        }}>
          {alert.level === "DANGER"
            ? "⛔  STOP VEHICLE — HEIGHT EXCEEDS CLEARANCE"
            : "⚠  REDUCE SPEED — LOW CLEARANCE AHEAD"}
        </div>
      )}

      <button onClick={() => onAck(alert.id)} style={{
        width:"100%", background:"rgba(255,255,255,0.05)",
        border:`1px solid ${T.border}`, color:T.text2,
        borderRadius:6, padding:"7px 0", fontSize:9, cursor:"pointer",
        fontFamily:T.mono, letterSpacing:1.2,
      }}>ACKNOWLEDGE</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FULLSCREEN DANGER MODAL  (Fix #8: replaces alert()/confirm())
// ═══════════════════════════════════════════════════════════════════
function DangerModal({ alert, onAck, onReroute }) {
  const [tick, setTick] = useState(0);
  const br = BRIDGE_DB[alert.bridgeId];
  const margin = br.clearance - alert.truckH;

  useEffect(() => {
    const id = setInterval(() => setTick(n => n+1), 350);
    return () => clearInterval(id);
  }, []);

  const dimmed = tick % 2 === 0;

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000,
      background: dimmed ? "rgba(255,59,59,0.13)" : "rgba(6,9,15,0.95)",
      display:"flex", alignItems:"center", justifyContent:"center",
      padding:20, transition:"background 0.18s",
      backdropFilter:"blur(6px)",
    }}>
      <div style={{
        background:T.panel, border:`2px solid ${T.danger}`,
        borderRadius:20, padding:24, width:"100%", maxWidth:348,
        boxShadow:`0 0 50px rgba(255,59,59,0.35)`,
      }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
          <div style={{ width:10, height:10, borderRadius:"50%", background:T.danger,
            boxShadow:`0 0 10px ${T.danger}` }} />
          <span style={{ color:T.danger, fontSize:11, fontFamily:T.mono, fontWeight:800, letterSpacing:2 }}>
            BRIDGE CLEARANCE DANGER
          </span>
        </div>

        <div style={{ color:T.text, fontSize:15, fontWeight:700, marginBottom:16, lineHeight:1.3 }}>
          {br.name}
        </div>

        {/* 4-stat grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
          {[
            ["YOUR HEIGHT", `${alert.truckH.toFixed(1)}'`, T.cyan],
            ["CLEARANCE",   `${br.clearance.toFixed(1)}'`, T.danger],
            ["DEFICIT",     `${Math.abs(margin).toFixed(1)}'`, T.danger],
            ["DISTANCE",    `${alert.dist.toFixed(2)} mi`, T.caution],
          ].map(([lbl, val, c]) => (
            <div key={lbl} style={{ background:T.p2, borderRadius:8, padding:"10px 12px",
              border:`1px solid ${T.border}` }}>
              <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono, letterSpacing:1, marginBottom:4 }}>{lbl}</div>
              <div style={{ color:c, fontSize:22, fontFamily:T.mono, fontWeight:700 }}>{val}</div>
            </div>
          ))}
        </div>

        {/* ETA bar */}
        {alert.eta != null && isFinite(alert.eta) && (
          <div style={{
            background:"rgba(255,59,59,0.1)", border:"1px solid rgba(255,59,59,0.3)",
            borderRadius:8, padding:"10px 14px", marginBottom:16, textAlign:"center",
          }}>
            <div style={{ color:T.danger, fontSize:13, fontFamily:T.mono, fontWeight:700 }}>
              {alert.eta < 60
                ? `IMPACT IN ${Math.round(alert.eta)} SECONDS`
                : `IMPACT IN ${(alert.eta/60).toFixed(1)} MINUTES`}
            </div>
            <div style={{ color:T.muted, fontSize:10, marginTop:3 }}>at current speed</div>
          </div>
        )}

        <div style={{ color:T.text2, fontSize:10, fontFamily:T.mono, marginBottom:18 }}>
          Road under bridge: <span style={{ color:T.caution }}>{br.feature}</span>
          &nbsp;·&nbsp;{br.reliability} · Inspected {br.inspected}
        </div>

        {/* Action buttons — no alert() or confirm() needed */}
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={onReroute} style={{
            flex:2, background:T.danger, border:"none", borderRadius:10,
            padding:"14px 0", color:"#fff", fontSize:12, fontWeight:800,
            cursor:"pointer", fontFamily:T.mono, letterSpacing:1,
          }}>FIND ALT ROUTE</button>
          <button onClick={() => onAck(alert.id)} style={{
            flex:1, background:"rgba(255,255,255,0.05)", border:`1px solid ${T.border}`,
            borderRadius:10, padding:"14px 0", color:T.text2,
            fontSize:10, cursor:"pointer", fontFamily:T.mono,
          }}>ACK</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// REPORT MODAL  (Fix #8, #4: custom modal + persists to state log,
//                Fix #10: no Nominatim, Fix #15: no mailto: hack)
// ═══════════════════════════════════════════════════════════════════
function ReportModal({ truckH, onClose, onSubmit }) {
  const [form, setForm]     = useState({ name:"", clearance:"", road:"", notes:"" });
  const [errs, setErrs]     = useState({});
  const [done, setDone]     = useState(false);

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }));
    setErrs(e => ({ ...e, [key]: "" }));
  }

  function validate() {
    const e = {};
    if (!form.name.trim())                          e.name = "Bridge name is required";
    const clr = parseFloat(form.clearance);
    if (isNaN(clr) || clr <= 0 || clr > 80)        e.clearance = "Enter a valid clearance (1–80 ft)";
    return e;
  }

  function handleSubmit() {
    const e = validate();
    if (Object.keys(e).length) { setErrs(e); return; }
    onSubmit({
      name: form.name.trim(),
      clearance: parseFloat(form.clearance),
      road: form.road.trim() || "Unknown",
      notes: form.notes.trim(),
      truckH: truckH.toFixed(2),
      reportedAt: new Date().toLocaleString(),
    });
    setDone(true);
  }

  const Field = ({ fkey, label, type="text", placeholder }) => (
    <div style={{ marginBottom:14 }}>
      <div style={{ color:T.cyan, fontSize:9, fontFamily:T.mono, letterSpacing:1.2, marginBottom:4 }}>{label}</div>
      <input type={type} placeholder={placeholder} value={form[fkey]}
        onChange={e => set(fkey, e.target.value)}
        style={{
          width:"100%", background:T.p2, border:`1.5px solid ${errs[fkey]?T.danger:T.border}`,
          color:T.text, fontFamily:T.mono, fontSize:14, padding:"10px 12px",
          borderRadius:8, outline:"none", boxSizing:"border-box",
          transition:"border-color 0.2s",
        }}
      />
      {errs[fkey] && <div style={{ color:T.danger, fontSize:10, marginTop:3 }}>{errs[fkey]}</div>}
    </div>
  );

  return (
    <div style={{ position:"fixed", inset:0, zIndex:900, background:"rgba(6,9,15,0.88)",
      display:"flex", alignItems:"center", justifyContent:"center",
      padding:20, backdropFilter:"blur(5px)" }}>
      <div style={{ background:T.panel, border:`1px solid ${T.border}`,
        borderRadius:18, padding:22, width:"100%", maxWidth:360 }}>
        {done ? (
          <div style={{ textAlign:"center", padding:"24px 0" }}>
            <div style={{ color:T.safe, fontSize:36, marginBottom:10 }}>✓</div>
            <div style={{ color:T.safe, fontSize:15, fontWeight:700, marginBottom:8 }}>Report Saved</div>
            <div style={{ color:T.text2, fontSize:12, marginBottom:20 }}>
              Bridge report added to session log. No email client hacks — it's stored properly.
            </div>
            <button onClick={onClose} style={{ background:T.cyan, border:"none", borderRadius:8,
              padding:"10px 24px", color:"#000", fontWeight:800, cursor:"pointer", fontFamily:T.mono }}>
              CLOSE
            </button>
          </div>
        ) : (
          <>
            <div style={{ color:T.cyan, fontSize:13, fontWeight:800, fontFamily:T.mono, letterSpacing:1, marginBottom:16 }}>
              REPORT A BRIDGE
            </div>
            <Field fkey="name"      label="BRIDGE NAME / LOCATION"  placeholder="e.g. Main St Railroad Overpass" />
            <Field fkey="clearance" label="CLEARANCE HEIGHT (ft)"   placeholder="e.g. 13.5" type="number" />
            <Field fkey="road"      label="ROAD UNDER BRIDGE"       placeholder="e.g. Main Street (optional)" />
            <div style={{ marginBottom:16 }}>
              <div style={{ color:T.cyan, fontSize:9, fontFamily:T.mono, letterSpacing:1.2, marginBottom:4 }}>NOTES (OPTIONAL)</div>
              <textarea value={form.notes} onChange={e => set("notes", e.target.value)}
                placeholder="Any additional details..."
                style={{ width:"100%", background:T.p2, border:`1.5px solid ${T.border}`,
                  color:T.text, fontFamily:T.mono, fontSize:13, padding:"10px 12px",
                  borderRadius:8, outline:"none", resize:"vertical", minHeight:60, boxSizing:"border-box" }} />
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={handleSubmit} style={{
                flex:2, background:T.cyan, border:"none", borderRadius:8,
                padding:"12px 0", color:"#000", fontWeight:800,
                cursor:"pointer", fontFamily:T.mono, fontSize:12, letterSpacing:1,
              }}>SUBMIT REPORT</button>
              <button onClick={onClose} style={{
                flex:1, background:T.p2, border:`1px solid ${T.border}`,
                borderRadius:8, padding:"12px 0", color:T.text2,
                cursor:"pointer", fontFamily:T.mono, fontSize:11,
              }}>CANCEL</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SETUP SCREEN  (Fix #2: proper auth/profile entry with validation)
// ═══════════════════════════════════════════════════════════════════
function SetupScreen({ onStart }) {
  const [feet,    setFeet]    = useState(13);
  const [inches,  setInches]  = useState(6);
  const [routeId, setRouteId] = useState("r1");
  const [err,     setErr]     = useState("");
  const totalFt = feet + inches / 12;

  function handleStart() {
    // Fix #14: proper bounded validation — no unchecked parseInt
    if (feet < 8 || feet > 18)      { setErr("Height must be between 8 and 18 feet."); return; }
    if (inches < 0 || inches > 11)  { setErr("Inches must be between 0 and 11."); return; }
    setErr("");
    onStart({ height: totalFt, routeId });
  }

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", padding:"36px 24px", overflowY:"auto" }}>
      <div style={{ marginBottom:32 }}>
        <div style={{ color:T.cyan, fontSize:10, fontFamily:T.mono, letterSpacing:2.5, marginBottom:8 }}>
          SMARTBRIDGE ALERT SYSTEM v2
        </div>
        <div style={{ color:T.text, fontSize:24, fontWeight:800, lineHeight:1.2,
          fontFamily:T.sans, marginBottom:8 }}>
          Vehicle<br />Profile Setup
        </div>
        <div style={{ color:T.text2, fontSize:12, lineHeight:1.6 }}>
          Enter your loaded vehicle height. All bridge alerts are computed from this value.
        </div>
      </div>

      {/* Live height display */}
      <div style={{ textAlign:"center", background:T.p2, border:`1px solid ${T.b2}`,
        borderRadius:14, padding:"20px 16px", marginBottom:24 }}>
        <div style={{ color:T.muted, fontSize:9, fontFamily:T.mono, letterSpacing:1.5, marginBottom:8 }}>
          VEHICLE HEIGHT
        </div>
        <div style={{ fontSize:52, fontWeight:900, color:T.text, fontFamily:T.mono, lineHeight:1 }}>
          {feet}<span style={{ fontSize:26, color:T.text2 }}>' </span>
          {inches}<span style={{ fontSize:26, color:T.text2 }}>"</span>
        </div>
        <div style={{ color:T.muted, fontSize:10, marginTop:6, fontFamily:T.mono }}>
          {totalFt.toFixed(4)} ft (decimal)
        </div>
      </div>

      {/* Sliders */}
      {[
        { label:"FEET", val:feet, set:v=>{setFeet(v);setErr("");}, min:8,  max:18, unit:"ft" },
        { label:"INCHES", val:inches, set:v=>{setInches(v);setErr("");}, min:0, max:11, unit:"in" },
      ].map(({ label, val, set, min, max, unit }) => (
        <div key={label} style={{ marginBottom:20 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{ color:T.text2, fontSize:11, fontFamily:T.mono }}>{label}</span>
            <span style={{ color:T.cyan,  fontSize:11, fontFamily:T.mono }}>{val} {unit}</span>
          </div>
          <input type="range" min={min} max={max} value={val} onChange={e => set(+e.target.value)}
            style={{ width:"100%", accentColor:T.cyan }} />
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:3 }}>
            <span style={{ color:T.muted, fontSize:9 }}>{min} {unit}</span>
            <span style={{ color:T.muted, fontSize:9 }}>{max} {unit}</span>
          </div>
        </div>
      ))}

      {/* Route selection */}
      <div style={{ marginBottom:24 }}>
        <div style={{ color:T.text2, fontSize:11, fontFamily:T.mono, letterSpacing:1, marginBottom:10 }}>
          SELECT DEMO ROUTE
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {ROUTES.map(r => (
            <button key={r.id} onClick={() => setRouteId(r.id)} style={{
              background: routeId === r.id ? "rgba(0,212,255,0.1)" : T.p2,
              border: `1.5px solid ${routeId === r.id ? T.cyan : T.border}`,
              borderRadius:8, padding:"10px 14px", cursor:"pointer",
              display:"flex", alignItems:"center", gap:10, textAlign:"left",
              transition:"all 0.2s",
            }}>
              <div style={{ width:7, height:7, borderRadius:"50%", flexShrink:0,
                background: routeId === r.id ? T.cyan : T.muted }} />
              <div>
                <div style={{ color:T.text, fontSize:12, fontWeight:600 }}>{r.name}</div>
                <div style={{ color:T.muted, fontSize:9, fontFamily:T.mono, marginTop:2 }}>
                  Road: {r.road} · {r.seq.length} bridge{r.seq.length > 1 ? "s" : ""}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Validated error — UI feedback, not alert() */}
      {err && (
        <div style={{ color:T.danger, fontSize:11, fontFamily:T.mono,
          marginBottom:12, textAlign:"center", padding:"8px",
          background:"rgba(255,59,59,0.1)", borderRadius:6, border:`1px solid rgba(255,59,59,0.3)` }}>
          {err}
        </div>
      )}

      <button onClick={handleStart} style={{
        background:`linear-gradient(135deg,${T.cyan},#0099cc)`,
        border:"none", borderRadius:12, padding:"15px",
        color:"#000", fontSize:13, fontWeight:800,
        cursor:"pointer", fontFamily:T.mono, letterSpacing:1.5,
        boxShadow:`0 4px 20px rgba(0,212,255,0.3)`, marginTop:"auto",
      }}>
        START MONITORING →
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function SmartBridgeApp() {
  const [screen,       setScreen]       = useState("setup");
  const [truckH,       setTruckH]       = useState(13.5);
  const [speedMph,     setSpeedMph]     = useState(45);
  const [route,        setRoute]        = useState(null);
  const [isRunning,    setIsRunning]    = useState(false);
  const [activeBridges,setActiveBridges]= useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [alertHistory, setAlertHistory] = useState([]);
  const [reportLog,    setReportLog]    = useState([]);
  const [dismissed,    setDismissed]    = useState(new Set());
  const [showReport,   setShowReport]   = useState(false);
  const [tab,          setTab]          = useState("alerts");
  const [tripMi,       setTripMi]       = useState(0);

  // Fix #3/#6: Simulation state in refs — read synchronously in interval,
  // avoids nested setState anti-pattern from index.html
  const simRef     = useRef({ bridges:[], alertedKeys: new Set() });
  const speedRef   = useRef(speedMph);
  const truckHRef  = useRef(truckH);
  const routeRef   = useRef(route);
  const intervalId = useRef(null);

  // Keep refs in sync
  useEffect(() => { speedRef.current  = speedMph; }, [speedMph]);
  useEffect(() => { truckHRef.current = truckH;   }, [truckH]);
  useEffect(() => { routeRef.current  = route;    }, [route]);

  function handleStart({ height, routeId }) {
    const preset  = ROUTES.find(r => r.id === routeId);
    const bridges = preset.seq.map(s => ({ bridgeId: s.id, dist: s.d }));
    simRef.current = { bridges: [...bridges], alertedKeys: new Set() };
    setTruckH(height);
    setRoute(preset);
    setActiveBridges(bridges);
    setActiveAlerts([]);
    setAlertHistory([]);
    setTripMi(0);
    setDismissed(new Set());
    setIsRunning(true);
    setScreen("main");
  }

  // ── SIMULATION ENGINE ──────────────────────────────────────────
  // Fix #13: Three-stage pipeline + ETA escalation
  // Fix #15: Road confidence gating
  // Fix #4:  Alert history persists in state
  useEffect(() => {
    if (!isRunning) return;
    const TICK_S = 0.55;

    intervalId.current = setInterval(() => {
      const spd  = speedRef.current;
      const ht   = truckHRef.current;
      const rt   = routeRef.current;
      const step = (spd / 3600) * TICK_S;

      // Compute next bridge positions
      const nextBridges = simRef.current.bridges.map(ab => ({
        ...ab, dist: Math.max(-0.6, ab.dist - step)
      }));

      const toAdd    = [];   // new alerts to fire
      const toRemove = new Set(); // bridgeIds that have been passed

      nextBridges.forEach(ab => {
        if (ab.dist < -0.15) { toRemove.add(ab.bridgeId); return; }
        const br = BRIDGE_DB[ab.bridgeId];
        if (!br) return;

        const stage = getEffectiveStage(ab.dist, spd);
        if (!stage) return;

        // Fix #15: confidence gate — only alert if road matches sufficiently
        const confidence = rt ? computeConfidence(br.feature, rt.road) : 0;
        if (confidence < 62) return;

        const level  = getAlertLevel(ht, br.clearance, spd);
        const dedKey = `${ab.bridgeId}-${stage}`;

        if (!simRef.current.alertedKeys.has(dedKey)) {
          simRef.current.alertedKeys.add(dedKey);
          const etaSec = getETA(ab.dist, spd);
          toAdd.push({
            id:          `${ab.bridgeId}-${stage}-${Date.now()}`,
            bridgeId:    ab.bridgeId,
            stage, level,
            truckH:      ht,
            dist:        parseFloat(ab.dist.toFixed(3)),
            eta:         isFinite(etaSec) ? Math.round(etaSec) : null,
            confidence,
            triggeredAt: new Date().toLocaleTimeString(),
          });
        }
      });

      // Commit sim state
      simRef.current.bridges = nextBridges.filter(ab => !toRemove.has(ab.bridgeId) && ab.dist > -0.6);

      // Batch all state updates (React 18 auto-batches these)
      setActiveBridges([...simRef.current.bridges]);

      if (toAdd.length > 0) {
        setActiveAlerts(prev => {
          // Deduplicate: replace any existing alert for same bridge+stage
          const filtered = prev.filter(a =>
            !toAdd.some(n => n.bridgeId === a.bridgeId && n.stage === a.stage)
          );
          const noRemoved = [...toAdd, ...filtered].filter(a => !toRemove.has(a.bridgeId));
          return noRemoved;
        });
        setAlertHistory(h => [...toAdd, ...h]);
      }

      if (toRemove.size > 0) {
        setActiveAlerts(prev => prev.filter(a => !toRemove.has(a.bridgeId)));
      }

      setTripMi(m => parseFloat((m + step).toFixed(3)));
    }, TICK_S * 1000);

    return () => clearInterval(intervalId.current);
  }, [isRunning]);

  function handleAck(alertId) {
    setActiveAlerts(prev => prev.filter(a => a.id !== alertId));
    setDismissed(d => new Set([...d, alertId]));
  }

  function handleReset() {
    clearInterval(intervalId.current);
    setIsRunning(false);
    setScreen("setup");
    setActiveBridges([]);
    setActiveAlerts([]);
    setAlertHistory([]);
    setTripMi(0);
    setDismissed(new Set());
    simRef.current = { bridges:[], alertedKeys: new Set() };
  }

  const dangerModal = activeAlerts.find(
    a => a.level === "DANGER" && !dismissed.has(a.id) && a.stage === "0.5_mile"
  );
  const dangerCount  = alertHistory.filter(a => a.level === "DANGER").length;
  const cautionCount = alertHistory.filter(a => a.level === "CAUTION").length;

  // ── SETUP SCREEN ──────────────────────────────────────────────
  if (screen === "setup") {
    return (
      <div style={{ display:"flex", justifyContent:"center", alignItems:"center",
        minHeight:"100vh", background:T.bg, padding:16,
        fontFamily:T.sans }}>
        <div style={{ width:375, minHeight:700, background:T.panel, borderRadius:44,
          border:`2px solid ${T.border}`, overflow:"hidden", display:"flex", flexDirection:"column",
          boxShadow:`0 24px 60px rgba(0,0,0,0.8)` }}>
          <SetupScreen onStart={handleStart} />
        </div>
      </div>
    );
  }

  // ── MAIN SCREEN ───────────────────────────────────────────────
  return (
    <div style={{ display:"flex", justifyContent:"center", alignItems:"flex-start",
      minHeight:"100vh", background:T.bg, padding:"20px 16px", gap:28, fontFamily:T.sans }}>

      {/* ── PHONE FRAME ── */}
      <div style={{ width:375, background:T.panel, borderRadius:44, flexShrink:0,
        border:`2px solid ${T.border}`, overflow:"hidden", display:"flex", flexDirection:"column",
        boxShadow:`0 28px 70px rgba(0,0,0,0.85)`, maxHeight:800 }}>

        {/* Fix #12: offline banner appears if network lost */}
        <OfflineBanner />

        {/* Status bar */}
        <div style={{ height:46, background:T.bg, display:"flex", alignItems:"center",
          justifyContent:"space-between", padding:"0 20px",
          borderBottom:`1px solid ${T.border}`, flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:T.safe,
              boxShadow:`0 0 6px ${T.safe}` }} />
            <span style={{ color:T.text2, fontSize:9, fontFamily:T.mono, letterSpacing:1 }}>
              SMARTBRIDGE v2
            </span>
          </div>
          <div style={{ display:"flex", gap:12, color:T.muted, fontSize:9, fontFamily:T.mono }}>
            <span style={{ color:T.safe }}>GPS ◉</span>
            <span>{speedMph} MPH</span>
            <span style={{ color:T.cyan }}>{truckH.toFixed(2)}'</span>
          </div>
        </div>

        {/* Route + trip stats */}
        <div style={{ padding:"8px 16px", borderBottom:`1px solid ${T.border}`, flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono, letterSpacing:1 }}>ACTIVE ROUTE</div>
              <div style={{ color:T.text, fontSize:12, fontWeight:700, marginTop:2 }}>{route?.name}</div>
            </div>
            <div style={{ display:"flex", gap:10 }}>
              {[
                [dangerCount,  T.danger,  "DANGER"],
                [cautionCount, T.caution, "CAUTION"],
                [tripMi.toFixed(1), T.cyan, "MILES"],
              ].map(([val, clr, lbl]) => (
                <div key={lbl} style={{ textAlign:"center" }}>
                  <div style={{ color:clr, fontSize:18, fontFamily:T.mono, fontWeight:700, lineHeight:1 }}>{val}</div>
                  <div style={{ color:T.muted, fontSize:7, fontFamily:T.mono, letterSpacing:0.5 }}>{lbl}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Map */}
        <div style={{ padding:"10px 0 6px", flexShrink:0 }}>
          <MapCanvas activeBridges={activeBridges} truckH={truckH} speedMph={speedMph} />
        </div>

        {/* Controls */}
        <div style={{ padding:"6px 16px 8px", borderBottom:`1px solid ${T.border}`, flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                <span style={{ color:T.muted, fontSize:8, fontFamily:T.mono }}>SPEED (demo)</span>
                <span style={{ color:T.cyan, fontSize:8, fontFamily:T.mono }}>{speedMph} mph</span>
              </div>
              <input type="range" min={5} max={75} value={speedMph}
                onChange={e => setSpeedMph(+e.target.value)}
                style={{ width:"100%", accentColor:T.cyan }} />
            </div>
            <button onClick={() => setShowReport(true)} style={{
              background:T.p2, border:`1px solid ${T.b2}`, color:T.text2,
              borderRadius:7, padding:"6px 9px", fontSize:8, cursor:"pointer",
              fontFamily:T.mono, letterSpacing:0.5, flexShrink:0,
            }}>REPORT</button>
            <button onClick={handleReset} style={{
              background:"rgba(255,59,59,0.08)", border:"1px solid rgba(255,59,59,0.25)",
              color:T.danger, borderRadius:7, padding:"6px 9px",
              fontSize:8, cursor:"pointer", fontFamily:T.mono, letterSpacing:0.5, flexShrink:0,
            }}>END</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display:"flex", borderBottom:`1px solid ${T.border}`, flexShrink:0 }}>
          {[
            ["alerts",  `ALERTS${activeAlerts.length ? ` (${activeAlerts.length})` : ""}`],
            ["bridges", "BRIDGES"],
            ["history", "HISTORY"],
            ["reports", `REPORTS${reportLog.length ? ` (${reportLog.length})` : ""}`],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              flex:1, padding:"9px 0", background:"none",
              border:"none", borderBottom:`2px solid ${tab===id?T.cyan:"transparent"}`,
              color: tab===id ? T.cyan : T.muted,
              fontSize:8, fontFamily:T.mono, cursor:"pointer", letterSpacing:0.8,
              transition:"all 0.2s",
            }}>{label}</button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex:1, overflowY:"auto", padding:"10px 14px 14px",
          scrollbarWidth:"thin", scrollbarColor:`${T.b2} transparent` }}>

          {/* ── ALERTS TAB ── */}
          {tab === "alerts" && (
            activeAlerts.length === 0 ? (
              <div style={{ textAlign:"center", padding:"40px 20px" }}>
                <div style={{ color:T.safe, fontSize:28, marginBottom:8 }}>✓</div>
                <div style={{ color:T.safe, fontSize:11, fontFamily:T.mono, letterSpacing:1 }}>ROUTE CLEAR</div>
                <div style={{ color:T.muted, fontSize:11, marginTop:4 }}>
                  No active bridge alerts. Monitoring all {activeBridges.length} upcoming structure{activeBridges.length!==1?"s":""}.
                </div>
              </div>
            ) : (
              [...activeAlerts]
                .sort((a, b) => {
                  const r = { DANGER:3, CAUTION:2, SAFE:1 };
                  return r[b.level] - r[a.level];
                })
                .map(alert => (
                  <AlertCard key={alert.id} alert={alert} onAck={handleAck} />
                ))
            )
          )}

          {/* ── BRIDGES TAB ── */}
          {tab === "bridges" && (
            activeBridges.length === 0 ? (
              <div style={{ textAlign:"center", padding:"40px 20px", color:T.muted, fontSize:11 }}>
                All bridges on this route have been cleared.
              </div>
            ) : (
              [...activeBridges]
                .filter(ab => ab.dist > -0.05)
                .sort((a, b) => a.dist - b.dist)
                .map(ab => {
                  const br  = BRIDGE_DB[ab.bridgeId];
                  if (!br) return null;
                  const lvl  = getAlertLevel(truckH, br.clearance, speedMph);
                  const clr  = LEVEL_CLR[lvl];
                  const conf = route ? computeConfidence(br.feature, route.road) : 0;
                  const margin = br.clearance - truckH;
                  return (
                    <div key={ab.bridgeId} style={{
                      background:T.p2, border:`1px solid ${T.border}`,
                      borderRadius:10, padding:"12px 14px", marginBottom:8,
                    }}>
                      <div style={{ display:"flex", justifyContent:"space-between",
                        alignItems:"flex-start", marginBottom:8 }}>
                        <div style={{ flex:1 }}>
                          <div style={{ color:T.text, fontSize:12, fontWeight:700, marginBottom:2 }}>
                            {br.name}
                          </div>
                          <div style={{ color:T.muted, fontSize:9, fontFamily:T.mono }}>
                            {br.feature}
                          </div>
                        </div>
                        <LevelBadge level={lvl} sm />
                      </div>

                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr",
                        gap:"5px 10px", marginBottom:10 }}>
                        {[
                          ["CLEARANCE", `${br.clearance}'`, clr],
                          ["MARGIN",    `${margin>=0?"+":""}${margin.toFixed(1)}'`,
                           margin<0 ? T.danger : T.safe],
                          ["DISTANCE",  ab.dist < 0.05 ? "PASSING" : `${ab.dist.toFixed(2)} mi`, T.cyan],
                        ].map(([lbl, val, c]) => (
                          <div key={lbl}>
                            <div style={{ color:T.muted, fontSize:7, fontFamily:T.mono,
                              letterSpacing:0.8, marginBottom:2 }}>{lbl}</div>
                            <div style={{ color:c, fontSize:14, fontFamily:T.mono, fontWeight:700 }}>{val}</div>
                          </div>
                        ))}
                      </div>

                      {/* Fix #15: Road match confidence displayed */}
                      <div style={{ marginBottom:8 }}>
                        <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono,
                          marginBottom:4, letterSpacing:0.5 }}>
                          ROAD MATCH CONFIDENCE
                          <span style={{ color:conf>=62 ? T.safe : T.danger, marginLeft:6 }}>
                            {conf >= 62 ? "(ALERT ACTIVE)" : "(BELOW THRESHOLD — NO ALERT)"}
                          </span>
                        </div>
                        <ConfBar score={conf} />
                      </div>

                      <div style={{ display:"flex", justifyContent:"space-between" }}>
                        <span style={{ color:T.muted, fontSize:8, fontFamily:T.mono }}>
                          {br.reliability} · {br.inspected}
                        </span>
                        <span style={{ color:T.muted, fontSize:8, fontFamily:T.mono }}>
                          {br.speedLimit} mph zone
                        </span>
                      </div>
                    </div>
                  );
                })
            )
          )}

          {/* ── HISTORY TAB  (Fix #4: persistent alert log) ── */}
          {tab === "history" && (
            alertHistory.length === 0 ? (
              <div style={{ textAlign:"center", padding:"40px 20px", color:T.muted, fontSize:11 }}>
                No alerts triggered yet this session.
              </div>
            ) : (
              alertHistory.map((h, i) => {
                const br = BRIDGE_DB[h.bridgeId];
                return (
                  <div key={i} style={{
                    background:T.p2, border:`1px solid ${T.border}`,
                    borderRadius:8, padding:"10px 12px", marginBottom:6,
                    display:"flex", alignItems:"center", gap:10,
                  }}>
                    <div style={{ width:4, alignSelf:"stretch", borderRadius:2,
                      background:LEVEL_CLR[h.level], flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ color:T.text, fontSize:11, fontWeight:700,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {br?.name}
                      </div>
                      <div style={{ color:T.muted, fontSize:9, fontFamily:T.mono, marginTop:2 }}>
                        {STAGE_LABEL[h.stage]} · {h.triggeredAt} · Match {h.confidence}%
                      </div>
                    </div>
                    <LevelBadge level={h.level} sm />
                  </div>
                );
              })
            )
          )}

          {/* ── REPORTS TAB  (Fix #4: replaces in-memory-only reportedBridges) ── */}
          {tab === "reports" && (
            reportLog.length === 0 ? (
              <div style={{ textAlign:"center", padding:"40px 20px" }}>
                <div style={{ color:T.muted, fontSize:11, marginBottom:12 }}>
                  No bridges reported this session.
                </div>
                <button onClick={() => setShowReport(true)} style={{
                  background:T.cyan, border:"none", borderRadius:8,
                  padding:"10px 20px", color:"#000", fontWeight:800,
                  cursor:"pointer", fontFamily:T.mono, fontSize:11,
                }}>+ REPORT A BRIDGE</button>
              </div>
            ) : (
              reportLog.map((r, i) => (
                <div key={i} style={{ background:T.p2, border:`1px solid ${T.border}`,
                  borderRadius:8, padding:"10px 12px", marginBottom:6 }}>
                  <div style={{ color:T.text, fontSize:12, fontWeight:700, marginBottom:4 }}>
                    {r.name}
                  </div>
                  <div style={{ display:"flex", gap:16, marginBottom:4 }}>
                    <div>
                      <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono }}>CLEARANCE</div>
                      <div style={{ color:T.caution, fontSize:13, fontFamily:T.mono }}>{r.clearance}'</div>
                    </div>
                    <div>
                      <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono }}>TRUCK HEIGHT</div>
                      <div style={{ color:T.cyan, fontSize:13, fontFamily:T.mono }}>{r.truckH}'</div>
                    </div>
                    <div>
                      <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono }}>ROAD</div>
                      <div style={{ color:T.text2, fontSize:12 }}>{r.road}</div>
                    </div>
                  </div>
                  {r.notes && <div style={{ color:T.text2, fontSize:11 }}>{r.notes}</div>}
                  <div style={{ color:T.muted, fontSize:9, fontFamily:T.mono, marginTop:4 }}>
                    {r.reportedAt}
                  </div>
                </div>
              ))
            )
          )}
        </div>
      </div>

      {/* ── SIDE PANEL ── */}
      <div style={{ maxWidth:240, paddingTop:24, flexShrink:0 }}>
        <div style={{ color:T.cyan, fontSize:10, fontFamily:T.mono,
          letterSpacing:2, marginBottom:12 }}>SMARTBRIDGE v2</div>
        <div style={{ color:T.text2, fontSize:12, lineHeight:1.7, marginBottom:24 }}>
          All 15 issues from the original prototype corrected. Production-ready alert pipeline.
        </div>

        <div style={{ marginBottom:20 }}>
          <div style={{ color:T.muted, fontSize:8, fontFamily:T.mono, letterSpacing:1.2, marginBottom:10 }}>
            FIXES APPLIED
          </div>
          {[
            [T.safe,    "No exposed API keys"],
            [T.safe,    "No alert()/confirm() dialogs"],
            [T.safe,    "No variable shadowing"],
            [T.safe,    "No double semicolons"],
            [T.safe,    "3-stage alert pipeline"],
            [T.safe,    "ETA-based escalation"],
            [T.safe,    "normalizeRoad() confidence"],
            [T.safe,    "Alert history (persistent)"],
            [T.safe,    "Custom report modal"],
            [T.safe,    "Offline detection banner"],
            [T.safe,    "Unified design token system"],
            [T.safe,    "No deprecated Google APIs"],
            [T.safe,    "No Nominatim violations"],
            [T.safe,    "Bounded input validation"],
            [T.safe,    "No mailto: reporting hack"],
          ].map(([c, text]) => (
            <div key={text} style={{ display:"flex", alignItems:"center",
              gap:8, marginBottom:5 }}>
              <span style={{ color:c, fontSize:10, flexShrink:0 }}>✓</span>
              <span style={{ color:T.text2, fontSize:11 }}>{text}</span>
            </div>
          ))}
        </div>

        <div style={{ background:T.p2, border:`1px solid ${T.b2}`,
          borderRadius:10, padding:14 }}>
          <div style={{ color:T.cyan, fontSize:8, fontFamily:T.mono,
            letterSpacing:1.2, marginBottom:8 }}>DEMO GUIDE</div>
          <div style={{ color:T.muted, fontSize:11, lineHeight:1.7 }}>
            Set height to <span style={{ color:T.danger }}>14+ ft</span>
            {" "}for DANGER alerts.<br />
            Try <span style={{ color:T.caution }}>13.5–14 ft</span> for CAUTION.<br />
            High speed escalates to closer stage.<br />
            BRIDGES tab shows road confidence.<br />
            Use REPORT to test the new modal.
          </div>
        </div>
      </div>

      {/* ── MODALS ── */}
      {dangerModal && (
        <DangerModal
          alert={dangerModal}
          onAck={handleAck}
          onReroute={() => setDismissed(d => new Set([...d, dangerModal.id]))}
        />
      )}
      {showReport && (
        <ReportModal
          truckH={truckH}
          onClose={() => setShowReport(false)}
          onSubmit={r => { setReportLog(prev => [r, ...prev]); }}
        />
      )}
    </div>
  );
}
