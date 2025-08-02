import { yAuth } from './sockets.js';

export function sendProposal({ symbol, amount, duration, contract_type }) {
  if (!yAuth || yAuth.readyState !== 1) return console.warn('yAuth not ready');

  const proposal = {
    proposal: 1,
    amount,
    basis: 'stake',
    contract_type,
    currency: 'USD',
    duration,
    duration_unit: 't',
    symbol,
  };

  yAuth.send(JSON.stringify(proposal));
}

export function buyContract(proposalId, price = 1) {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({
    buy: proposalId,
    price,
  }));
}

export function sellContract(contractId) {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({
    sell: contractId,
    price: 0, // will auto-calculate market price
  }));
}

export function getPortfolio() {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({ portfolio: 1 }));
}

export function cancelAll() {
  if (!yAuth || yAuth.readyState !== 1) return;

  yAuth.send(JSON.stringify({ sell_expired: 1 }));
}

export function fullScreen(el, toggle = null, iconEl = null) {
  const isActive = el.dataset.fullscreen === "true";

  // Auto-detect if toggle isn't specified
  toggle = toggle ?? !isActive;

  // Create/reuse overlay
  let overlay = document.getElementById("fullscreen-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "fullscreen-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: 0, left: 0,
      width: "100vw",
      height: "100vh",
      background: "rgba(0,0,0,0.6)",
      opacity: 0,
      zIndex: 9998,
      transition: "opacity 0.4s ease",
      pointerEvents: "none"
    });
    document.body.appendChild(overlay);
  }

  if (toggle) {
    // Save original style
    const r = el.getBoundingClientRect();
    el.dataset.fullscreen = "true";
    el.dataset.originalStyle = el.getAttribute("style") || "";

    // Hide all other UI except footer
    document.querySelectorAll("header, section.user-header, .risk-entry, .login-card, .toast, .fab-bar ~ *:not(footer)")
      .forEach(e => e.classList.add("hidden"));

    // Apply initial transform state
    Object.assign(el.style, {
      transition: "all 0.4s ease",
      transform: "scale(1)",
      position: "fixed",
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      zIndex: 9999,
      background: "#000",
      boxShadow: "0 0 40px rgba(0,0,0,0.6)"
    });

    requestAnimationFrame(() => {
      Object.assign(el.style, {
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        transform: "scale(1.01)"
      });
      overlay.style.opacity = "1";
    });

    // Update icon (if provided)
    if (iconEl) iconEl.textContent = "fullscreen_exit";

  } else {
    el.dataset.fullscreen = "false";
    el.style.transition = "all 0.4s ease";
    el.style.transform = "scale(0.98)";
    overlay.style.opacity = "0";

    // Restore original size then revert style
    setTimeout(() => {
      const original = el.dataset.originalStyle || "";
      el.removeAttribute("style");
      if (original) el.setAttribute("style", original);

      document.querySelectorAll(".hidden").forEach(e => e.classList.remove("hidden"));
    }, 400);

    if (iconEl) iconEl.textContent = "fullscreen";
  }
}

export const showToast = (msg) => {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
};

