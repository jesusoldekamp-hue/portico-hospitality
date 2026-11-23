const slides = [...document.querySelectorAll('.slide')];
let current = 0;

function updateView() {
  slides.forEach((s, i) => s.classList.toggle('active', i === current));
  const counter = document.getElementById('slide-counter');
  if (counter) counter.textContent = `${current + 1} / ${slides.length}`;
  if (!document.body.classList.contains('present-mode')) {
    slides[current]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

document.getElementById('btn-prev')?.addEventListener('click', () => {
  current = Math.max(0, current - 1);
  updateView();
});

document.getElementById('btn-next')?.addEventListener('click', () => {
  current = Math.min(slides.length - 1, current + 1);
  updateView();
});

const toggleBtn = document.getElementById('btn-toggle-mode');
toggleBtn?.addEventListener('click', () => {
  const active = document.body.classList.toggle('present-mode');
  toggleBtn.textContent = active ? 'Ver todas' : 'Modo Presentación';
  updateView();
});

document.getElementById('btn-print-pdf')?.addEventListener('click', () => {
  window.print();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'PageDown') {
    current = Math.min(slides.length - 1, current + 1);
    updateView();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    current = Math.max(0, current - 1);
    updateView();
  }
});
