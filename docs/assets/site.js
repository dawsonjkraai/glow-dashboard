// Glow Dashboard's site: the hero's reel turning while it is held, the demo house steered from the
// page's names, the feature list you can type into, entrances, the questions and the clock.
(() => {
  document.documentElement.classList.remove('no-js');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- The reel: one frame further for every step of scroll while the hero is held ----
  const hero = document.querySelector('.hero');
  const track = document.querySelector('.reel-track');
  if (hero && track) {
    const frames = track.children.length;
    let queued = false;
    const turn = () => {
      queued = false;
      const r = hero.getBoundingClientRect();
      const span = hero.offsetHeight - innerHeight;
      const t = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0;
      track.style.setProperty('--p', reduced ? Math.round(t * (frames - 1)) : (t * (frames - 1)).toFixed(4));
    };
    addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(turn); } }, { passive: true });
    addEventListener('resize', turn);
    turn();
  }

  // ---- Entrances: the parts of each section, one after another ----
  const enter = document.querySelectorAll('[data-enter]');
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const group = e.target.parentElement ? [...e.target.parentElement.querySelectorAll(':scope > [data-enter]')] : [e.target];
        group.forEach((el, i) => {
          el.style.setProperty('--d', `${i * 80}ms`);
          el.classList.add('in');
          io.unobserve(el);
        });
      }
    }, { rootMargin: '0px 0px -10% 0px' });
    enter.forEach((el) => io.observe(el));
  } else enter.forEach((el) => el.classList.add('in'));

  // ---- The demo house: loaded as it comes near, steered by the names beside it ----
  const sheet = document.querySelector('.sheet');
  const frame = sheet?.querySelector('iframe');
  const wake = sheet?.querySelector('.wake');
  const names = [...document.querySelectorAll('.name')];
  let want = 'Home';
  let ready = false;

  const doc = () => {
    try {
      return frame.contentDocument;
    } catch {
      return null;
    }
  };

  /** Inside the demo: start the demo house if it asks, close any notice, and open the page wanted. */
  const steer = () => {
    const d = doc();
    if (!d) return false;
    const start = [...d.querySelectorAll('button')].find((b) => /Try the demo house/i.test(b.textContent));
    if (start) {
      start.click();
      return false;
    }
    d.querySelector('.notice .x')?.click();
    const items = [...d.querySelectorAll('nav .item')];
    if (!items.length) return false;
    // An item's text can start with its badge ("10 Lights"): match the words only.
    const item = items.find((i) => i.textContent.replace(/[0-9+]+/g, '').trim().startsWith(want));
    item?.click();
    return true;
  };

  const load = () => {
    if (!frame || frame.src) return;
    frame.src = frame.dataset.src;
    frame.addEventListener('load', () => {
      let tries = 0;
      const tick = setInterval(() => {
        tries++;
        if (steer() || tries > 60) {
          clearInterval(tick);
          ready = true;
          sheet.classList.add('live');
          if (tries > 60 && wake) wake.hidden = false;
        }
      }, 250);
    });
  };

  if (frame) {
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          load();
          io.disconnect();
        }
      }, { rootMargin: '400px 0px' });
      io.observe(sheet);
    } else load();
    wake?.addEventListener('click', () => {
      wake.hidden = true;
      steer();
    });
  }

  names.forEach((btn) =>
    btn.addEventListener('click', () => {
      want = btn.dataset.page;
      names.forEach((n) => {
        const on = n === btn;
        n.classList.toggle('is-on', on);
        n.setAttribute('aria-selected', String(on));
      });
      load();
      if (ready) steer();
    }),
  );

  // ---- The feature list: type to narrow it, arrows or the pointer to choose ----
  const input = document.querySelector('.cmd-search input');
  const rows = [...document.querySelectorAll('.cmd-list li')];
  const empty = document.querySelector('.cmd-empty');
  const select = (li) => rows.forEach((r) => r.setAttribute('aria-selected', String(r === li)));
  const visible = () => rows.filter((r) => !r.hidden);
  input?.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    rows.forEach((r) => (r.hidden = !!q && !r.textContent.toLowerCase().includes(q)));
    const v = visible();
    if (empty) empty.hidden = v.length > 0;
    if (v.length && !v.some((r) => r.getAttribute('aria-selected') === 'true')) select(v[0]);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const v = visible();
    const at = v.findIndex((r) => r.getAttribute('aria-selected') === 'true');
    const next = v[(at + (e.key === 'ArrowDown' ? 1 : -1) + v.length) % v.length];
    if (next) select(next);
  });
  rows.forEach((r) => {
    r.addEventListener('mouseenter', () => select(r));
    r.addEventListener('click', () => select(r));
  });

  // ---- Questions: one open at a time (where the browser doesn't do it itself) ----
  const qs = [...document.querySelectorAll('details[name="faq"]')];
  qs.forEach((d) =>
    d.addEventListener('toggle', () => {
      if (d.open) qs.forEach((o) => o !== d && (o.open = false));
    }),
  );

  // ---- The clock on the last tile ----
  const clock = document.querySelector('[data-clock]');
  const date = document.querySelector('[data-date]');
  const tock = () => {
    const now = new Date();
    if (clock) clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (date) date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  tock();
  setInterval(tock, 15_000);
})();
