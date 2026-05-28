const slider = document.getElementById('pendiente');
const triangulo = document.getElementById('triangulo');
const valor = document.getElementById('valor');
const caja = document.getElementById('caja');
const rectEl = document.querySelector('.cuadrado');

const CAJA_SIZE = 40;
const G = 1e-6; // fracción/ms²

let posX = 0.9; // posición horizontal como fracción del ancho (0=izq, 1=der)
let vel = 0;
let lastTime = null;

function getTheta() {
  const w = rectEl.clientWidth;
  const h = rectEl.clientHeight;
  // Ángulo de la pendiente respecto a la horizontal
  return Math.atan2(h * slider.value / 100, w);
}

function renderCaja() {
  const w = rectEl.clientWidth;
  const h = rectEl.clientHeight;
  const theta = getTheta();

  // Punto sobre la hipotenusa en posX
  const x = posX * w;
  const y = h * (1 - posX * slider.value / 100);

  // Desplazar el centro de la caja perpendicular a la pendiente (hacia arriba)
  const cx = x - Math.sin(theta) * CAJA_SIZE / 2;
  const cy = y - Math.cos(theta) * CAJA_SIZE / 2;

  caja.style.left = `${cx - CAJA_SIZE / 2}px`;
  caja.style.top  = `${cy - CAJA_SIZE / 2}px`;
  caja.style.transform = `rotate(${-theta}rad)`;
}

function animate(timestamp) {
  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min(timestamp - lastTime, 50);
  lastTime = timestamp;

  // Aceleración real en plano inclinado: a = g·sin(θ)
  const theta = getTheta();
  vel  += G * Math.sin(theta) * dt;
  posX -= vel * dt;

  if (posX <= 0) {
    posX = 0.9;
    vel = 0;
    lastTime = null;
  }

  renderCaja();
  requestAnimationFrame(animate);
}

function reset() {
  posX = 0.9;
  vel = 0;
  lastTime = null;
}

slider.addEventListener('input', () => {
  const apice = 100 - slider.value;
  triangulo.style.clipPath = `polygon(0% 100%, 100% 100%, 100% ${apice}%)`;
  valor.textContent = `${slider.value}%`;
  reset();
});

requestAnimationFrame(animate);
