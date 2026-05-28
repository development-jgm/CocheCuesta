const slider     = document.getElementById('pendiente');
const triangulo  = document.getElementById('triangulo');
const valor      = document.getElementById('valor');
const caja       = document.getElementById('caja');
const rectEl     = document.querySelector('.cuadrado');
const frenoMano  = document.getElementById('frenoMano');
const wfEl         = document.getElementById('wf');
const wrEl         = document.getElementById('wr');
const carroceriaEl = document.getElementById('carroceria');
const humoSvg      = document.getElementById('humo');

const CAJA_W = 320;
const CAJA_H = 160;

// Ratios de marchas (velocidad máxima en cada marcha como % de MAX_VEL)
const GEAR_RATIOS = {
  'N': 0.0,
  '1': 0.45,
  '2': 0.6,
  '3': 0.75,
  '4': 0.9,
  '5': 1.0
};

// Parámetros del modelo — sobreescritos por config.json al arrancar
let SLOPE_M           = 30;
let MAX_VEL           = 0.0008;
let ENGINE_MAX_VEL    = 0.0003;
let ACCEL_RATE        = 0.003;
let BRAKE_RATE        = 0.05;
let STALL_TIME        = 1500;
let STALL_THRESHOLD   = 0.75;
let BRAKE_DEADBAND    = 97;
let CLUTCH_ENABLE_THR = 97;
let INITIAL_POSX      = 0.9;
let AUDIO_FREQ_IDLE   = 47;
let AUDIO_FREQ_MAX    = 200;
let AUDIO_VOL_IDLE    = 0.35;
let AUDIO_VOL_MAX     = 0.60;
let AUDIO_INERTIA     = 0.18;
let AUDIO_FILT_MIN    = 130;
let AUDIO_FILT_MAX    = 520;

async function loadConfig() {
  try {
    const cfg = await fetch('config.json').then(r => r.json());
    SLOPE_M           = cfg.simulacion?.longitud_cuesta_m           ?? SLOPE_M;
    INITIAL_POSX      = cfg.simulacion?.posicion_inicial             ?? INITIAL_POSX;
    MAX_VEL           = cfg.fisica?.velocidad_max_bajada             ?? MAX_VEL;
    ACCEL_RATE        = cfg.fisica?.tasa_aceleracion                 ?? ACCEL_RATE;
    BRAKE_RATE        = cfg.fisica?.tasa_frenado                     ?? BRAKE_RATE;
    ENGINE_MAX_VEL    = cfg.motor?.velocidad_max_ralenti              ?? ENGINE_MAX_VEL;
    RPM_IDLE          = cfg.motor?.rpm_ralenti                       ?? RPM_IDLE;
    RPM_MAX           = cfg.motor?.rpm_max                           ?? RPM_MAX;
    BRAKE_DEADBAND    = cfg.freno?.zona_muerta_pct                   ?? BRAKE_DEADBAND;
    CLUTCH_ENABLE_THR = cfg.embrague?.umbral_activacion_marchas_pct  ?? CLUTCH_ENABLE_THR;
    STALL_THRESHOLD   = cfg.embrague?.umbral_calado                  ?? STALL_THRESHOLD;
    STALL_TIME        = cfg.embrague?.tiempo_calado_ms               ?? STALL_TIME;
    AUDIO_FREQ_IDLE   = cfg.audio?.frecuencia_ralenti_hz             ?? AUDIO_FREQ_IDLE;
    AUDIO_FREQ_MAX    = cfg.audio?.frecuencia_max_hz                 ?? AUDIO_FREQ_MAX;
    AUDIO_VOL_IDLE    = cfg.audio?.volumen_ralenti                   ?? AUDIO_VOL_IDLE;
    AUDIO_VOL_MAX     = cfg.audio?.volumen_max                       ?? AUDIO_VOL_MAX;
    AUDIO_INERTIA     = cfg.audio?.inercia_motor_s                   ?? AUDIO_INERTIA;
    AUDIO_FILT_MIN    = cfg.audio?.filtro_cutoff_min_hz              ?? AUDIO_FILT_MIN;
    AUDIO_FILT_MAX    = cfg.audio?.filtro_cutoff_max_hz              ?? AUDIO_FILT_MAX;
  } catch {
    console.warn('config.json no encontrado — usando valores por defecto');
  }
}

let posX         = INITIAL_POSX;
let wheelAngle   = 0; // grados acumulados de rotación de las ruedas
let vel          = 0;
let lastTime     = null;
let brakeValue       = 0;
let clutchValue      = 0;
let acceleratorValue = 0;
let gear             = 'N';
let engineRunning    = false;
let engineStalled    = false;
let stallTimer       = 0;
let handbrake        = true;
let arduinoConnected = false;

const gearInputs = document.querySelectorAll('input[name="marcha"]');

function updateGearSelector() {
  const enabled = clutchValue >= CLUTCH_ENABLE_THR;
  gearInputs.forEach(inp => inp.disabled = !enabled);
}

gearInputs.forEach(inp =>
  inp.addEventListener('change', () => {
    if (!inp.disabled) {
      gear = inp.value;
      stallTimer = 0; // resetea timer al cambiar marcha
    }
  })
);

// ── Pendiente ─────────────────────────────────────────────────────────────────

function applyPendiente(val) {
  val = Math.max(0, Math.min(100, val));
  slider.value = val;
  triangulo.style.clipPath = `polygon(0% 100%, 100% 100%, 100% ${100 - val}%)`;
  valor.textContent = `${val}%`;
}

slider.addEventListener('input', () => {
  applyPendiente(Number(slider.value));
  // Al cambiar pendiente, solo detiene el movimiento pero mantiene la posición
  vel = 0;
  lastTime = null;
});

// ── Física ────────────────────────────────────────────────────────────────────

function getTheta() {
  return Math.atan2(rectEl.clientHeight * slider.value / 100, rectEl.clientWidth);
}

function renderCaja() {
  const w     = rectEl.clientWidth;
  const h     = rectEl.clientHeight;
  const theta = getTheta();
  const x     = posX * w;
  const y     = h * (1 - posX * slider.value / 100);
  const cx    = x - Math.sin(theta) * CAJA_H / 2;
  const cy    = y - Math.cos(theta) * CAJA_H / 2;

  caja.style.left      = `${cx - CAJA_W / 2}px`;
  caja.style.top       = `${cy - CAJA_H / 2}px`;
  caja.style.transform = `rotate(${-theta}rad)`;
}

function animate(timestamp) {
  requestAnimationFrame(animate); // al principio: el bucle nunca se detiene aunque algo falle

  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min(timestamp - lastTime, 50);
  lastTime = timestamp;

  const theta          = getTheta();
  const effectiveBrake = handbrake ? 100 : brakeValue;

  // Gravedad: siempre cuesta abajo (vel negativa)
  const gravVelTarget = -MAX_VEL * Math.sin(theta);

  // Motor: cuesta arriba proporcional al embrague soltado y acelerador
  const engagement    = gear !== 'N' ? Math.max(0, 1 - clutchValue / 100) : 0;
  const gearRatio     = GEAR_RATIOS[gear] || 0;
  const accelFactor   = acceleratorValue / 100; // 0 a 1 según pedal acelerador
  // Boost de engagement solo si estamos bajando (necesitamos frenar la caída)
  const isDescending = vel < -ENGINE_MAX_VEL * 0.1;
  const engagementBoost = isDescending ? engagement * (1 - accelFactor) * 0.5 : 0;
  const effectiveAccel = accelFactor + engagementBoost;
  const motorVelMax   = ENGINE_MAX_VEL + (MAX_VEL - ENGINE_MAX_VEL) * gearRatio * effectiveAccel;
  let engineVelTarget = (engineRunning && !engineStalled && gear !== 'N') ? motorVelMax * engagement : 0;

  // Target combinado, luego frenado
  const physTarget = gravVelTarget + engineVelTarget;

  // ── Lógica de calado ──────────────────────────────────────────────────────
  // Se cala si embrague soltado sin acelerador suficiente y sin inercia
  // Cuando está bajando, necesita más acelerador para no calarse
  // También se cala si hay freno fuerte (freno de mano o freno de pedal fuerte)
  const minAccelForMaintain = isDescending ? 0.15 : 0.02;
  const isAcceleratingEnough = accelFactor >= minAccelForMaintain;
  const hasEnoughSpeed = vel < 0 && Math.abs(vel) > ENGINE_MAX_VEL * 0.5; // inercia de bajada
  const strongBrake = effectiveBrake > 50; // freno muy fuerte
  const shouldStall = engagement > STALL_THRESHOLD && !isAcceleratingEnough &&
                      (!hasEnoughSpeed || (strongBrake && acceleratorValue <= 0));
  if (engineRunning && !engineStalled && gear !== 'N') {
    if (shouldStall) {
      stallTimer += dt;
      if (stallTimer >= STALL_TIME) {
        engineStalled = true;
        showStallMessage();
      }
    } else {
      stallTimer = 0;
    }
  }
  // Arrantar: requiere casilla marcada + embrague a fondo para reiniciar
  if (engineStalled && clutchValue >= CLUTCH_ENABLE_THR && arrancarEl.checked) {
    engineStalled = false;
    stallTimer    = 0;
  }
  updateStallLight(engineStalled);
  const targetVel  = effectiveBrake >= BRAKE_DEADBAND ? 0 : physTarget * (1 - effectiveBrake / 100);

  const decelerating = Math.abs(targetVel) < Math.abs(vel) ||
                       (vel !== 0 && Math.sign(targetVel) !== Math.sign(vel));
  const rate = decelerating ? BRAKE_RATE : ACCEL_RATE;
  vel += (targetVel - vel) * Math.min(1, rate * dt);

  posX += vel * dt;
  if (posX <= 0) { posX = 0; if (vel < 0) vel = 0; }
  if (posX >= 1) { posX = 1; if (vel > 0) vel = 0; }

  // Radio rueda: 9 SVG units × escala (320px / 80 SVG) = 36 px
  const wheelRpx = 9 * (CAJA_W / 80);
  // vel<0 = baja (antihorario), vel>0 = sube (horario)
  wheelAngle += (vel * rectEl.clientWidth / wheelRpx) * (180 / Math.PI) * dt;
  wfEl.setAttribute('transform', `rotate(${wheelAngle}, 16, 31)`);
  wrEl.setAttribute('transform', `rotate(${wheelAngle}, 62, 31)`);

  // Temblor de carrocería proporcional a las RPM (ruedas no se mueven)
  if (engineRunning && !engineStalled) {
    const rpmNorm = RPM_IDLE / RPM_MAX + (acceleratorValue / 100) * (1 - RPM_IDLE / RPM_MAX);
    const amp = 0.15 + rpmNorm * 0.55; // 0.15–0.70 SVG units → ~0.6–2.8 px a escala ×4
    const dx  = amp * 0.4  * Math.sin(timestamp * 0.071);
    const dy  = amp * (Math.sin(timestamp * 0.047) + 0.35 * Math.sin(timestamp * 0.131));
    carroceriaEl.setAttribute('transform', `translate(${dx.toFixed(3)},${dy.toFixed(3)})`);
  } else {
    carroceriaEl.setAttribute('transform', 'translate(0,0)');
  }

  renderCaja();
  // Velocímetro solo muestra velocidad si: motor conectado, no calado, y moviéndose hacia adelante
  const movingForward = vel > 0;
  const displaySpeed = (gear !== 'N' && !engineStalled && movingForward) ? vel * SLOPE_M * 3600 : 0;
  updateGauge(displaySpeed);
  const rpm = (engineRunning && !engineStalled)
    ? RPM_IDLE + (acceleratorValue / 100) * (RPM_MAX - RPM_IDLE)
    : 0;
  updateRpmGauge(rpm);
  updateEngineSound(acceleratorValue, engineRunning && !engineStalled);

  // Partículas de humo proporcionales a RPM (coordenadas SVG diretas)
  updateParticles(dt);
  if (engineRunning && !engineStalled) {
    const spawnRate = 0.06 + (rpm / RPM_MAX) * 0.14; // leve en ralentí, aumenta con acelerador
    const toSpawn = Math.round(spawnRate * dt); // usar round en lugar de floor
    if (toSpawn > 0) {
      spawnSmoke(3, 27, toSpawn, rpm); // salida del tubo de escape en coordenadas SVG
    }
  }
}

function reset() {
  posX     = INITIAL_POSX;
  vel      = 0;
  lastTime = null;
}

// ── Velocímetro SVG ───────────────────────────────────────────────────────────

const GCX = 120, GCX2 = 360, GCY = 108, GR = 88;
const G_START = 225, G_SWEEP = 270, G_MAX = 160;
const RPM_GAUGE_MAX = 8000, RPM_RED_ZONE = 6000;

let RPM_IDLE = 700;
let RPM_MAX  = 6500;

function gAngle(val, maxVal = G_MAX) {
  return G_START + (Math.min(Math.max(val, 0), maxVal) / maxVal) * G_SWEEP;
}

function gPoint(deg, r, cx = GCX, cy = GCY) {
  const a = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function gArc(fromDeg, toDeg, r, cx = GCX, cy = GCY) {
  const p1    = gPoint(fromDeg, r, cx, cy);
  const p2    = gPoint(toDeg,   r, cx, cy);
  const sweep = ((toDeg - fromDeg) + 720) % 360;
  return `M ${p1.x.toFixed(1)},${p1.y.toFixed(1)} A ${r},${r} 0 ${sweep > 180 ? 1 : 0},1 ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
}

function svgEl(tag, attrs, text) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function initGauge() {
  const svg = document.getElementById('gauge');

  // Definiciones: degradado y filtros glow (createElementNS, sin innerHTML)
  const defs = svgEl('defs', {});

  const grad = svgEl('radialGradient', { id: 'bgGrad', cx: '50%', cy: '50%', r: '50%' });
  grad.appendChild(svgEl('stop', { offset: '0%',   'stop-color': '#1c1c1c' }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#070707' }));
  defs.appendChild(grad);

  function makeFilter(id, blur) {
    const f   = svgEl('filter', { id, x: '-40%', y: '-40%', width: '180%', height: '180%' });
    const gb  = svgEl('feGaussianBlur', { stdDeviation: blur, result: 'b' });
    const mer = svgEl('feMerge', {});
    mer.appendChild(svgEl('feMergeNode', { in: 'b' }));
    mer.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' }));
    f.appendChild(gb);
    f.appendChild(mer);
    return f;
  }
  defs.appendChild(makeFilter('glow',     3));
  defs.appendChild(makeFilter('softglow', 1.5));
  svg.appendChild(defs);

  // Bisel exterior
  svg.appendChild(svgEl('circle', { cx: GCX, cy: GCY, r: GR + 18, fill: '#151515', stroke: '#2e2e2e', 'stroke-width': 2 }));
  // Fondo interior con degradado
  svg.appendChild(svgEl('circle', { cx: GCX, cy: GCY, r: GR + 10, fill: 'url(#bgGrad)' }));
  // Anillo interior decorativo
  svg.appendChild(svgEl('circle', { cx: GCX, cy: GCY, r: GR + 3, fill: 'none', stroke: '#1a1a1a', 'stroke-width': 4 }));

  // Pista de fondo (arco gris oscuro)
  svg.appendChild(svgEl('path', {
    d: gArc(G_START, G_START + G_SWEEP, GR - 6),
    fill: 'none', stroke: '#1c1c1c', 'stroke-width': 14, 'stroke-linecap': 'round'
  }));

  // Zona roja (120–160 km/h)
  svg.appendChild(svgEl('path', {
    d: gArc(gAngle(120), gAngle(G_MAX), GR - 6),
    fill: 'none', stroke: '#2a0505', 'stroke-width': 14, 'stroke-linecap': 'round'
  }));

  // Arco de velocidad activo (dinámico)
  svg.appendChild(svgEl('path', {
    id: 'speedArc', d: 'M 0,0',
    fill: 'none', stroke: '#00cc44', 'stroke-width': 7,
    'stroke-linecap': 'round', opacity: 0, filter: 'url(#softglow)'
  }));

  // Ticks menores (cada 10 km/h)
  for (let s = 0; s <= G_MAX; s += 10) {
    if (s % 20 === 0) continue;
    const a  = gAngle(s);
    const p1 = gPoint(a, GR - 1);
    const p2 = gPoint(a, GR - 9);
    svg.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: '#333', 'stroke-width': 1 }));
  }

  // Ticks mayores y números (cada 20 km/h)
  for (let s = 0; s <= G_MAX; s += 20) {
    const a  = gAngle(s);
    const p1 = gPoint(a, GR - 1);
    const p2 = gPoint(a, GR - 15);
    svg.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: '#888', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    const np = gPoint(a, GR - 27);
    svg.appendChild(svgEl('text', {
      x: np.x, y: np.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      fill: s >= 120 ? '#882222' : '#666', 'font-size': 10, 'font-family': 'Arial,sans-serif'
    }, s));
  }

  // Etiqueta km/h
  svg.appendChild(svgEl('text', {
    x: GCX, y: GCY + 32, 'text-anchor': 'middle',
    fill: '#333', 'font-size': 8, 'font-family': 'Arial,sans-serif', 'letter-spacing': 3
  }, 'km/h'));

  // Aguja
  svg.appendChild(svgEl('line', {
    id: 'gaugeNeedle',
    x1: GCX, y1: GCY + 14, x2: GCX, y2: GCY - (GR - 20),
    stroke: '#ff3c3c', 'stroke-width': 2.5, 'stroke-linecap': 'round',
    transform: `rotate(${G_START}, ${GCX}, ${GCY})`,
    filter: 'url(#glow)'
  }));

  // Cubo central
  svg.appendChild(svgEl('circle', { cx: GCX, cy: GCY, r: 11, fill: '#111', stroke: '#3a3a3a', 'stroke-width': 1.5 }));
  svg.appendChild(svgEl('circle', { cx: GCX, cy: GCY, r: 4, fill: '#555' }));

  // Display digital — fondo
  svg.appendChild(svgEl('rect', { x: GCX - 36, y: GCY + 40, width: 72, height: 26, rx: 4, fill: '#030303', stroke: '#1c1c1c' }));
  // Display digital — texto
  svg.appendChild(svgEl('text', {
    id: 'gaugeDigital', x: GCX, y: GCY + 58,
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: '#39ff14', 'font-size': 17, 'font-family': "'Courier New',monospace",
    'font-weight': 'bold', filter: 'url(#softglow)'
  }, '0.0'));

  // ODO (decorativo)
  svg.appendChild(svgEl('rect', { x: GCX - 30, y: GCY + 72, width: 60, height: 13, rx: 2, fill: '#020202', stroke: '#111' }));
  svg.appendChild(svgEl('text', {
    x: GCX, y: GCY + 79, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: '#2a2a2a', 'font-size': 7, 'font-family': "'Courier New',monospace"
  }, '00000 km'));

  // Testigo de motor calado (apagado por defecto)
  svg.appendChild(svgEl('circle', { id: 'stallLight', cx: GCX - 55, cy: GCY + 75, r: 7, fill: '#1a0000' }));
  svg.appendChild(svgEl('text', {
    x: GCX - 55, y: GCY + 88, 'text-anchor': 'middle',
    fill: '#2a0000', 'font-size': 6, 'font-family': 'Arial,sans-serif', 'letter-spacing': 0.5
  }, 'MOTOR'));
  svg.appendChild(svgEl('text', {
    id: 'stallText',
    x: GCX + 10, y: GCY + 88, 'text-anchor': 'middle',
    fill: '#1a0000', 'font-size': 7.5, 'font-family': 'Arial,sans-serif',
    'font-weight': 'bold', 'letter-spacing': 1
  }, 'CALADO'));

  // ── Tacómetro ────────────────────────────────────────────────────────────────
  buildRpmDial(svg);
}

function buildRpmDial(svg) {
  const cx = GCX2, cy = GCY, r = GR;

  svg.appendChild(svgEl('circle', { cx, cy, r: r + 18, fill: '#151515', stroke: '#2e2e2e', 'stroke-width': 2 }));
  svg.appendChild(svgEl('circle', { cx, cy, r: r + 10, fill: 'url(#bgGrad)' }));
  svg.appendChild(svgEl('circle', { cx, cy, r: r + 3,  fill: 'none', stroke: '#1a1a1a', 'stroke-width': 4 }));

  svg.appendChild(svgEl('path', {
    d: gArc(G_START, G_START + G_SWEEP, r - 6, cx, cy),
    fill: 'none', stroke: '#1c1c1c', 'stroke-width': 14, 'stroke-linecap': 'round'
  }));
  svg.appendChild(svgEl('path', {
    d: gArc(gAngle(RPM_RED_ZONE, RPM_GAUGE_MAX), gAngle(RPM_GAUGE_MAX, RPM_GAUGE_MAX), r - 6, cx, cy),
    fill: 'none', stroke: '#2a0505', 'stroke-width': 14, 'stroke-linecap': 'round'
  }));
  svg.appendChild(svgEl('path', {
    id: 'rpmArc', d: 'M 0,0', fill: 'none', stroke: '#00cc44', 'stroke-width': 7,
    'stroke-linecap': 'round', opacity: 0, filter: 'url(#softglow)'
  }));

  // Ticks menores (cada 500 rpm)
  for (let v = 500; v < RPM_GAUGE_MAX; v += 1000) {
    const a  = gAngle(v, RPM_GAUGE_MAX);
    const p1 = gPoint(a, r - 1,  cx, cy);
    const p2 = gPoint(a, r - 9,  cx, cy);
    svg.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: '#333', 'stroke-width': 1 }));
  }
  // Ticks mayores + etiquetas (cada 1000 rpm, muestra x1000)
  for (let v = 0; v <= RPM_GAUGE_MAX; v += 1000) {
    const a  = gAngle(v, RPM_GAUGE_MAX);
    const p1 = gPoint(a, r - 1,  cx, cy);
    const p2 = gPoint(a, r - 15, cx, cy);
    svg.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: '#888', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    const np = gPoint(a, r - 27, cx, cy);
    svg.appendChild(svgEl('text', {
      x: np.x, y: np.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      fill: v >= RPM_RED_ZONE ? '#882222' : '#666', 'font-size': 10, 'font-family': 'Arial,sans-serif'
    }, (v / 1000).toString()));
  }

  svg.appendChild(svgEl('text', {
    x: cx, y: cy + 32, 'text-anchor': 'middle',
    fill: '#333', 'font-size': 7, 'font-family': 'Arial,sans-serif', 'letter-spacing': 2
  }, 'x1000 rpm'));

  svg.appendChild(svgEl('line', {
    id: 'rpmNeedle',
    x1: cx, y1: cy + 14, x2: cx, y2: cy - (r - 20),
    stroke: '#ff3c3c', 'stroke-width': 2.5, 'stroke-linecap': 'round',
    transform: `rotate(${G_START}, ${cx}, ${cy})`,
    filter: 'url(#glow)'
  }));

  svg.appendChild(svgEl('circle', { cx, cy, r: 11, fill: '#111', stroke: '#3a3a3a', 'stroke-width': 1.5 }));
  svg.appendChild(svgEl('circle', { cx, cy, r: 4, fill: '#555' }));

  svg.appendChild(svgEl('rect', { x: cx - 36, y: cy + 40, width: 72, height: 26, rx: 4, fill: '#030303', stroke: '#1c1c1c' }));
  svg.appendChild(svgEl('text', {
    id: 'rpmDigital', x: cx, y: cy + 58,
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: '#39ff14', 'font-size': 17, 'font-family': "'Courier New',monospace",
    'font-weight': 'bold', filter: 'url(#softglow)'
  }, '0'));

  svg.appendChild(svgEl('rect', { x: cx - 30, y: cy + 72, width: 60, height: 13, rx: 2, fill: '#020202', stroke: '#111' }));
  svg.appendChild(svgEl('text', {
    x: cx, y: cy + 79, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: '#2a2a2a', 'font-size': 7, 'font-family': "'Courier New',monospace"
  }, 'MOTOR'));
}

function updateRpmGauge(rpm) {
  const angle = gAngle(rpm, RPM_GAUGE_MAX);

  const needle = document.getElementById('rpmNeedle');
  if (needle) needle.setAttribute('transform', `rotate(${angle}, ${GCX2}, ${GCY})`);

  const arc = document.getElementById('rpmArc');
  if (arc) {
    if (rpm < 10) {
      arc.setAttribute('opacity', 0);
    } else {
      arc.setAttribute('opacity', 1);
      arc.setAttribute('d', gArc(G_START, angle, GR - 6, GCX2, GCY));
      arc.setAttribute('stroke',
        rpm < 3000 ? '#00cc44' :
        rpm < 5500 ? '#ffaa00' : '#ff3333');
    }
  }

  const dig = document.getElementById('rpmDigital');
  if (dig) dig.textContent = Math.round(rpm);
}

function updateGauge(speedKmh) {
  const angle = gAngle(speedKmh);

  document.getElementById('gaugeNeedle')
    .setAttribute('transform', `rotate(${angle}, ${GCX}, ${GCY})`);

  const arc = document.getElementById('speedArc');
  if (speedKmh < 0.5) {
    arc.setAttribute('opacity', 0);
  } else {
    arc.setAttribute('opacity', 1);
    arc.setAttribute('d', gArc(G_START, angle, GR - 6));
    arc.setAttribute('stroke',
      speedKmh < 60  ? '#00cc44' :
      speedKmh < 100 ? '#ffaa00' : '#ff3333');
  }

  document.getElementById('gaugeDigital').textContent = speedKmh.toFixed(1);
}

function updateStallLight(stalled) {
  const light = document.getElementById('stallLight');
  const text  = document.getElementById('stallText');
  // Desactiva la casilla si está calado, pero reactiva si presiona clutch a fondo
  const clutchFull = clutchValue >= CLUTCH_ENABLE_THR;
  arrancarEl.disabled = stalled && !clutchFull;
  arrancarEl.checked = !stalled && arrancarEl.checked;
  if (!light || !text) return;
  if (stalled) {
    light.setAttribute('fill', '#ff2020');
    light.setAttribute('filter', 'url(#glow)');
    text.setAttribute('fill', '#ff4040');
  } else {
    light.setAttribute('fill', '#1a0000');
    light.removeAttribute('filter');
    text.setAttribute('fill', '#1a0000');
  }
}

// ── Partículas de humo ────────────────────────────────────────────────────────

class Particle {
  constructor(el) {
    this.el = el;
    this.reset();
  }
  reset() {
    this.age = 0;
    this.life = 2000;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.r = 0;
  }
}

const PARTICLE_POOL_SIZE = 150;
const particles = [];
let particlePool = [];

function initParticlePool() {
  for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('fill', '#999');
    circle.setAttribute('opacity', '0');
    humoSvg.appendChild(circle);
    particles.push(new Particle(circle));
  }
  particlePool = [...particles];
}

function spawnSmoke(escapeX, escapeY, count, rpm) {
  const accelFactor = rpm / RPM_MAX; // 0 (ralentí) a 1 (fondo)
  for (let i = 0; i < count; i++) {
    if (particlePool.length === 0) break;
    const p = particlePool.pop();
    p.reset();
    p.age = 0;
    p.life = 1500 + Math.random() * 500;
    p.x = escapeX + (Math.random() - 0.5) * 8;
    p.y = escapeY + (Math.random() - 0.5) * 4;
    // Humo despedido hacia la izquierda (vx negativa = izquierda)
    p.vx = -(0.1 + Math.random() * 0.15) * (0.4 + accelFactor * 0.6); // ralentí leve, fondo fuerte
    const baseVy = 0.06 + accelFactor * 0.12; // ralentí 0.06, fondo 0.18
    p.vy = -baseVy - Math.random() * (0.05 * accelFactor);
    p.r = 1.5 + Math.random() * 1;
  }
}

function updateParticles(dt) {
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p.age >= p.life) {
      if (particlePool.indexOf(p) === -1) particlePool.push(p);
      continue;
    }
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const prog = p.age / p.life;
    const opacity = (1 - prog) * (1 - prog);
    const radius = p.r * (1 + prog * 2);

    p.el.setAttribute('cx', p.x);
    p.el.setAttribute('cy', p.y);
    p.el.setAttribute('r', radius);
    p.el.setAttribute('opacity', opacity.toFixed(3));
  }
}

// ── Audio: sonido del motor ───────────────────────────────────────────────────

let audioCtx    = null;
let engineOsc1  = null; // oscilador principal (sawtooth)
let engineOsc2  = null; // desafinado → batimiento rugoso
let engineOsc3  = null; // sub-octava cuadrada → cuerpo grave
let engineFilt  = null;
let engineGain  = null;
let idleLfo     = null; // modula amplitud → irregularidad de pistones
let idleLfoGain = null;

function makeSoftClipCurve(amount) {
  const n = 512;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const f = AUDIO_FREQ_IDLE;

  engineOsc1 = audioCtx.createOscillator();
  engineOsc1.type = 'sawtooth';
  engineOsc1.frequency.value = f;

  engineOsc2 = audioCtx.createOscillator(); // ligeramente plano → batimiento
  engineOsc2.type = 'sawtooth';
  engineOsc2.frequency.value = f * 0.985;

  engineOsc3 = audioCtx.createOscillator(); // sub-octava → graves
  engineOsc3.type = 'square';
  engineOsc3.frequency.value = f * 0.5;

  const g1 = audioCtx.createGain(); g1.gain.value = 0.50;
  const g2 = audioCtx.createGain(); g2.gain.value = 0.30;
  const g3 = audioCtx.createGain(); g3.gain.value = 0.38;

  // WaveShaper: distorsión suave → armónicos graves (ronco)
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeSoftClipCurve(80);
  shaper.oversample = '4x';

  // Paso-bajo muy agresivo: elimina agudos → carácter grave de coche
  engineFilt = audioCtx.createBiquadFilter();
  engineFilt.type = 'lowpass';
  engineFilt.frequency.value = AUDIO_FILT_MIN;
  engineFilt.Q.value = 4;

  // LFO: modula amplitud al ritmo de pistones → irregularidad de ralentí
  idleLfo = audioCtx.createOscillator();
  idleLfo.type = 'sine';
  idleLfo.frequency.value = 4;

  idleLfoGain = audioCtx.createGain();
  idleLfoGain.gain.value = 0.12;

  // Nodo que recibe la modulación del LFO (ganancia base = 1)
  const lfoAmp = audioCtx.createGain();
  lfoAmp.gain.value = 1;
  idleLfo.connect(idleLfoGain);
  idleLfoGain.connect(lfoAmp.gain);

  engineGain = audioCtx.createGain();
  engineGain.gain.value = 0;

  // Cadena: osciladores → shaper → filtro → lfoAmp → ganancia → salida
  engineOsc1.connect(g1); g1.connect(shaper);
  engineOsc2.connect(g2); g2.connect(shaper);
  engineOsc3.connect(g3); g3.connect(shaper);
  shaper.connect(engineFilt);
  engineFilt.connect(lfoAmp);
  lfoAmp.connect(engineGain);
  engineGain.connect(audioCtx.destination);

  engineOsc1.start();
  engineOsc2.start();
  engineOsc3.start();
  idleLfo.start();
}

function updateEngineSound(accelPct, running) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;

  if (!running) {
    engineGain.gain.setTargetAtTime(0, t, 0.15);
    return;
  }

  const freq = AUDIO_FREQ_IDLE + (accelPct / 100) * (AUDIO_FREQ_MAX - AUDIO_FREQ_IDLE);
  engineOsc1.frequency.setTargetAtTime(freq,         t, AUDIO_INERTIA);
  engineOsc2.frequency.setTargetAtTime(freq * 0.985, t, AUDIO_INERTIA);
  engineOsc3.frequency.setTargetAtTime(freq * 0.5,   t, AUDIO_INERTIA);

  // Filtro se abre con las RPM (más brillante acelerando, más cerrado en ralentí)
  const fcut = AUDIO_FILT_MIN + (accelPct / 100) * (AUDIO_FILT_MAX - AUDIO_FILT_MIN);
  engineFilt.frequency.setTargetAtTime(fcut, t, AUDIO_INERTIA);

  // LFO más rápido al acelerar, menor profundidad (menos variación a altas rpm)
  idleLfo.frequency.setTargetAtTime(4 + (accelPct / 100) * 10, t, AUDIO_INERTIA * 2);
  idleLfoGain.gain.setTargetAtTime(0.12 * (1 - accelPct / 180), t, AUDIO_INERTIA);

  const vol = AUDIO_VOL_IDLE + (accelPct / 100) * (AUDIO_VOL_MAX - AUDIO_VOL_IDLE);
  engineGain.gain.setTargetAtTime(vol, t, AUDIO_INERTIA);
}

function showStallMessage() {
  const stallMsg = document.getElementById('stall-message');
  stallMsg.classList.remove('show');
  // Fuerza reflow para reiniciar animación
  void stallMsg.offsetWidth;
  stallMsg.classList.add('show');
}

loadConfig().then(() => {
  applyPendiente(Number(slider.value));
  posX = INITIAL_POSX;
  initGauge();
  initParticlePool();
  requestAnimationFrame(animate);
  autoConnectArduino(); // intenta reconectar silenciosamente si hay permiso previo
});

// ── Freno de mano + Web Serial ────────────────────────────────────────────────

const arrancarEl = document.getElementById('arrancar');
arrancarEl.addEventListener('change', () => {
  engineRunning = arrancarEl.checked;
  if (engineRunning) {
    initAudio();       // gesto del usuario → AudioContext permitido
    engineStalled = false; // arranque limpio (también re-arranca tras calado)
    stallTimer    = 0;
  }
});

frenoMano.addEventListener('change', async () => {
  handbrake = frenoMano.checked;
  if (!handbrake && !arduinoConnected) {
    await connectArduino();
  }
});

async function openSerialPort(port) {
  await port.open({ baudRate: 9600 });
  arduinoConnected = true;
  const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const parts = line.trim().split(',');
      if (parts.length < 2) continue;
      const rawBrake  = parseInt(parts[0], 10);
      const rawClutch = parseInt(parts[1], 10);
      if (!isNaN(rawBrake)) {
        let v = Math.max(0, Math.min(100, rawBrake));
        if (v >= BRAKE_DEADBAND) v = 100;
        brakeValue = v;
      }
      if (!isNaN(rawClutch)) {
        clutchValue = Math.max(0, Math.min(100, rawClutch));
        updateGearSelector();
      }
      const rawAccel = parseInt(parts[2], 10);
      if (!isNaN(rawAccel)) {
        acceleratorValue = Math.max(0, Math.min(100, rawAccel));
      }
    }
  }
}

// Intenta conectar al arrancar si ya hay permiso concedido (sin popup)
async function autoConnectArduino() {
  if (!navigator.serial) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length > 0) await openSerialPort(ports[0]);
  } catch { /* sin permiso previo — se conectará al soltar el freno */ }
}

async function connectArduino() {
  if (arduinoConnected) return;
  try {
    const ports = await navigator.serial.getPorts();
    const port  = ports.length > 0
      ? ports[0]
      : await navigator.serial.requestPort();
    await openSerialPort(port);
  } catch (err) {
    console.error(err);
    if (err.name === 'NotFoundError' || err.name === 'AbortError') {
      handbrake = true;
      frenoMano.checked = true;
    }
    // Cualquier otro error (puerto no disponible, etc.): el coche cae igualmente
  }
}
