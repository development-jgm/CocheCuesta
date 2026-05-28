const slider     = document.getElementById('pendiente');
const triangulo  = document.getElementById('triangulo');
const valor      = document.getElementById('valor');
const caja       = document.getElementById('caja');
const rectEl     = document.querySelector('.cuadrado');
const btnArduino = document.getElementById('btnArduino');

const CAJA_SIZE = 40;
const MAX_VEL    = 0.0008; // velocidad máxima (fracción del ancho / ms)
const ACCEL_RATE = 0.003;  // ritmo de aceleración (lento, como la gravedad)
const BRAKE_RATE = 0.05;   // ritmo de frenada (rápido, como un freno de disco)

let posX      = 0.9;
let vel       = 0;
let lastTime  = null;
let brakeValue = 0; // 0-100, recibido del Arduino

// ── Pendiente (solo slider) ───────────────────────────────────────────────────

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

  const x  = posX * w;
  const y  = h * (1 - posX * slider.value / 100);
  const cx = x - Math.sin(theta) * CAJA_SIZE / 2;
  const cy = y - Math.cos(theta) * CAJA_SIZE / 2;

  caja.style.left      = `${cx - CAJA_SIZE / 2}px`;
  caja.style.top       = `${cy - CAJA_SIZE / 2}px`;
  caja.style.transform = `rotate(${-theta}rad)`;
}

function animate(timestamp) {
  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min(timestamp - lastTime, 50);
  lastTime = timestamp;

  const theta     = getTheta();
  const targetVel = MAX_VEL * Math.sin(theta) * Math.sqrt(1 - brakeValue / 100);
  const rate      = vel > targetVel ? BRAKE_RATE : ACCEL_RATE;

  vel  += (targetVel - vel) * Math.min(1, rate * dt);
  vel   = Math.max(0, vel);
  posX -= vel * dt;

  if (posX <= 0) {
    posX = 0.9;
    vel  = 0;
    lastTime = null;
  }

  renderCaja();
  requestAnimationFrame(animate);
}

function reset() {
  posX     = 0.9;
  vel      = 0;
  lastTime = null;
}

requestAnimationFrame(animate);

// ── Web Serial (freno) ────────────────────────────────────────────────────────

btnArduino.addEventListener('click', async () => {
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });

    btnArduino.textContent = 'Arduino conectado';
    btnArduino.disabled    = true;

    const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const val = parseInt(line.trim(), 10);
        if (!isNaN(val)) brakeValue = Math.max(0, Math.min(100, val));
      }
    }
  } catch (err) {
    console.error(err);
    btnArduino.textContent = 'Error — reintentar';
    btnArduino.disabled    = false;
  }
});
