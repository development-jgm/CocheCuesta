const slider     = document.getElementById('pendiente');
const triangulo  = document.getElementById('triangulo');
const valor      = document.getElementById('valor');
const caja       = document.getElementById('caja');
const rectEl     = document.querySelector('.cuadrado');
const frenoMano  = document.getElementById('frenoMano');
const wfEl       = document.getElementById('wf');
const wrEl       = document.getElementById('wr');

const CAJA_W = 320;
const CAJA_H = 160;

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
let AUDIO_FREQ_IDLE   = 65;
let AUDIO_FREQ_MAX    = 210;
let AUDIO_VOL_IDLE    = 0.07;
let AUDIO_VOL_MAX     = 0.45;
let AUDIO_INERTIA     = 0.18;

async function loadConfig() {
  try {
    const cfg = await fetch('config.json').then(r => r.json());
    SLOPE_M           = cfg.simulacion?.longitud_cuesta_m           ?? SLOPE_M;
    INITIAL_POSX      = cfg.simulacion?.posicion_inicial             ?? INITIAL_POSX;
    MAX_VEL           = cfg.fisica?.velocidad_max_bajada             ?? MAX_VEL;
    ACCEL_RATE        = cfg.fisica?.tasa_aceleracion                 ?? ACCEL_RATE;
    BRAKE_RATE        = cfg.fisica?.tasa_frenado                     ?? BRAKE_RATE;
    ENGINE_MAX_VEL    = cfg.motor?.velocidad_max_ralenti              ?? ENGINE_MAX_VEL;
    BRAKE_DEADBAND    = cfg.freno?.zona_muerta_pct                   ?? BRAKE_DEADBAND;
    CLUTCH_ENABLE_THR = cfg.embrague?.umbral_activacion_marchas_pct  ?? CLUTCH_ENABLE_THR;
    STALL_THRESHOLD   = cfg.embrague?.umbral_calado                  ?? STALL_THRESHOLD;
    STALL_TIME        = cfg.embrague?.tiempo_calado_ms               ?? STALL_TIME;
    AUDIO_FREQ_IDLE   = cfg.audio?.frecuencia_ralenti_hz             ?? AUDIO_FREQ_IDLE;
    AUDIO_FREQ_MAX    = cfg.audio?.frecuencia_max_hz                 ?? AUDIO_FREQ_MAX;
    AUDIO_VOL_IDLE    = cfg.audio?.volumen_ralenti                   ?? AUDIO_VOL_IDLE;
    AUDIO_VOL_MAX     = cfg.audio?.volumen_max                       ?? AUDIO_VOL_MAX;
    AUDIO_INERTIA     = cfg.audio?.inercia_motor_s                   ?? AUDIO_INERTIA;
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
  inp.addEventListener('change', () => { if (!inp.disabled) gear = inp.value; })
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
  reset();
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

  // Motor: cuesta arriba proporcional al embrague soltado
  const engagement    = gear !== 'N' ? Math.max(0, 1 - clutchValue / 100) : 0;
  let engineVelTarget = engineStalled ? 0 : ENGINE_MAX_VEL * engagement;

  // Target combinado, luego frenado
  const physTarget = gravVelTarget + engineVelTarget;

  // ── Lógica de calado ──────────────────────────────────────────────────────
  // A ralentí, soltar el embrague más del 65% de recorrido cala el motor
  if (!engineStalled && gear !== 'N') {
    if (engagement > STALL_THRESHOLD) {
      stallTimer += dt;
      if (stallTimer >= STALL_TIME) engineStalled = true;
    } else {
      stallTimer = 0; // embrague pisado suficiente: timer se resetea
    }
  }
  // Arrancar: embrague a fondo reinicia el motor
  if (engineStalled && clutchValue >= CLUTCH_ENABLE_THR) {
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

  renderCaja();
  updateGauge(Math.abs(vel) * SLOPE_M * 3600);
  updateEngineSound(acceleratorValue, !engineStalled);
}

function reset() {
  posX     = INITIAL_POSX;
  vel      = 0;
  lastTime = null;
}

// ── Velocímetro SVG ───────────────────────────────────────────────────────────

const GCX = 120, GCY = 108, GR = 88;
const G_START = 225, G_SWEEP = 270, G_MAX = 160;

function gAngle(spd) {
  return G_START + (Math.min(spd, G_MAX) / G_MAX) * G_SWEEP;
}

function gPoint(deg, r) {
  const a = (deg - 90) * Math.PI / 180;
  return { x: GCX + r * Math.cos(a), y: GCY + r * Math.sin(a) };
}

function gArc(fromDeg, toDeg, r) {
  const p1    = gPoint(fromDeg, r);
  const p2    = gPoint(toDeg, r);
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

// ── Audio: sonido del motor ───────────────────────────────────────────────────

let audioCtx   = null;
let engineOsc  = null;
let engineFilt = null;
let engineGain = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  engineOsc = audioCtx.createOscillator();
  engineOsc.type = 'sawtooth';
  engineOsc.frequency.setValueAtTime(AUDIO_FREQ_IDLE, audioCtx.currentTime);

  engineFilt = audioCtx.createBiquadFilter();
  engineFilt.type = 'lowpass';
  engineFilt.frequency.setValueAtTime(400, audioCtx.currentTime);
  engineFilt.Q.setValueAtTime(2, audioCtx.currentTime);

  engineGain = audioCtx.createGain();
  engineGain.gain.setValueAtTime(AUDIO_VOL_IDLE, audioCtx.currentTime);

  engineOsc.connect(engineFilt);
  engineFilt.connect(engineGain);
  engineGain.connect(audioCtx.destination);
  engineOsc.start();
}

function updateEngineSound(accelPct, running) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  if (!running) {
    engineGain.gain.setTargetAtTime(0, t, 0.1);
    return;
  }
  const freq = AUDIO_FREQ_IDLE + (accelPct / 100) * (AUDIO_FREQ_MAX - AUDIO_FREQ_IDLE);
  const vol  = AUDIO_VOL_IDLE  + (accelPct / 100) * (AUDIO_VOL_MAX  - AUDIO_VOL_IDLE);
  // Filtro más abierto a altas revoluciones
  const fcut = 300 + (accelPct / 100) * 1200;

  engineOsc.frequency.setTargetAtTime(freq, t, AUDIO_INERTIA);
  engineGain.gain.setTargetAtTime(vol,  t, AUDIO_INERTIA);
  engineFilt.frequency.setTargetAtTime(fcut, t, AUDIO_INERTIA);
}

loadConfig().then(() => {
  posX = INITIAL_POSX; // aplicar posición inicial del config
  initGauge();
  requestAnimationFrame(animate);
});

// ── Freno de mano + Web Serial ────────────────────────────────────────────────

frenoMano.addEventListener('change', async () => {
  handbrake = frenoMano.checked;
  initAudio(); // primer gesto del usuario → AudioContext permitido
  if (!handbrake && !arduinoConnected) {
    await connectArduino();
  }
});

async function connectArduino() {
  try {
    const ports = await navigator.serial.getPorts();
    const port  = ports.length > 0
      ? ports[0]
      : await navigator.serial.requestPort();
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
  } catch (err) {
    console.error(err);
    // Solo reactivar el freno si el usuario canceló explícitamente el selector de puerto
    if (err.name === 'NotFoundError' || err.name === 'AbortError') {
      handbrake = true;
      frenoMano.checked = true;
    }
    // Cualquier otro error (puerto no disponible, etc.): el coche cae igualmente
  }
}
