// Collapse long how-to text into a small (i) icon; the text shows on hover or tap.
// Opt out with data-no-tip on an element (or an ancestor); opt in with data-tip.
(() => {
  if (window.__helpTips) return; window.__helpTips = true;

  const SELECTOR = [
    "h1 + p", "h2 + p", ".head p", ".page-head p", ".page-header p",
    "p.hint", "div.hint", "p.muted", "div.muted", "p.lead", "small.muted",
    ".analysis-hint", ".sv-hint", ".sv-lead", ".sv-info", ".rq-lead", ".tw-note", ".field-hint",
    ".file-help", ".fc-note", ".st-note", ".mr-muted", ".muted-line", ".us-note", ".ps-note",
    ".quota-note", ".lp-muted", ".in-muted", ".sc-info", ".auth-subtitle", ".help-text", "[data-tip]"
  ].join(",");
  const SKIP = "[data-no-tip],nav,.sidebar,.bottom-bar,.mobile-bar,table,.notice,.alert,.toast,[role=alert],[role=status],[aria-live],button,a,select,option,.badge";
  const INLINE_OK = /^(B|STRONG|EM|I|BR|CODE|SMALL|SPAN|U|MARK|KBD|SUP|SUB)$/;
  const MIN_LEN = 28;

  const css = document.createElement("style");
  css.textContent = `
.htip-src{display:none!important}
.htip-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;padding:0;margin:0 0 0 6px;border:1px solid var(--color-border,rgba(72,91,112,.25));border-radius:50%;background:var(--color-surface,#fff);color:var(--color-ocean-700,#1669C9);font:700 12px/1 Georgia,serif;font-style:italic;cursor:help;vertical-align:middle;box-shadow:0 1px 2px rgba(28,44,61,.08);transition:background .15s,color .15s,transform .15s}
.htip-btn:hover,.htip-btn:focus-visible,.htip-btn[aria-expanded=true]{background:var(--color-ocean-700,#1669C9);color:#fff;outline:none;transform:scale(1.08)}
.htip-row{display:block;margin:2px 0 6px}
.htip-row>.htip-btn{margin-left:0}
.htip-pop{position:fixed;z-index:10050;max-width:min(340px,calc(100vw - 24px));padding:10px 12px;border-radius:10px;background:#1C2A39;color:#F4F7FA;font-size:13px;line-height:1.55;font-weight:400;box-shadow:0 12px 32px rgba(15,25,40,.28);white-space:normal;text-align:left;pointer-events:auto}
.htip-pop b,.htip-pop strong{color:#fff}
.htip-pop[hidden]{display:none}
@media print{.htip-btn,.htip-pop{display:none!important}.htip-src{display:block!important}}`;
  document.head.append(css);

  const pop = document.createElement("div");
  pop.className = "htip-pop"; pop.id = "htipPop"; pop.setAttribute("role", "tooltip"); pop.hidden = true;
  let current = null, pinned = false;

  function place(btn) {
    const r = btn.getBoundingClientRect(), p = pop.getBoundingClientRect();
    let left = Math.min(Math.max(8, r.left + r.width / 2 - p.width / 2), innerWidth - p.width - 8);
    let top = r.bottom + 8;
    if (top + p.height > innerHeight - 8) top = Math.max(8, r.top - p.height - 8);
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }
  function show(btn) {
    const src = btn.__src; if (!src) return;
    const html = src.innerHTML.trim(); if (!html) return;
    if (!pop.isConnected) document.body.append(pop);
    if (current && current !== btn) current.setAttribute("aria-expanded", "false");
    pop.innerHTML = html; pop.hidden = false; current = btn;
    btn.setAttribute("aria-expanded", "true"); place(btn);
  }
  function hide() {
    pop.hidden = true; pinned = false;
    if (current) current.setAttribute("aria-expanded", "false");
    current = null;
  }

  function eligible(el) {
    if (el.__htip || el.classList.contains("htip-src") || el.hidden) return false;
    if (el.closest(SKIP) && !el.hasAttribute("data-tip")) return false;
    if (/(error|warn|danger|alert|status|empty)/i.test(el.className + " " + el.id)) return false;
    for (const c of el.querySelectorAll("*")) if (!INLINE_OK.test(c.tagName)) return false;
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (el.hasAttribute("data-tip")) return text.length > 0;
    return text.length >= MIN_LEN && !text.includes("${");
  }

  function convert(el) {
    el.__htip = true;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "htip-btn"; btn.textContent = "i";
    btn.setAttribute("aria-label", "คำอธิบายการใช้งาน"); btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-describedby", "htipPop"); btn.__src = el;
    const prev = el.previousElementSibling;
    const head = prev && /^(H1|H2|H3|H4|H5|H6|LEGEND)$/.test(prev.tagName) ? prev : null;
    if (head) {
      head.append(btn);
      // Pages that rewrite the heading text would drop the icon; put it back.
      new MutationObserver(() => { if (!head.contains(btn)) head.append(btn); }).observe(head, { childList: true });
    } else {
      const row = document.createElement(el.closest("label") ? "span" : "div");
      row.className = "htip-row"; row.append(btn); el.before(row);
    }
    el.classList.add("htip-src");
  }

  function scan(root) { root.querySelectorAll(SELECTOR).forEach(el => { if (eligible(el)) convert(el); }); }

  document.addEventListener("mouseover", e => {
    const b = e.target.closest && e.target.closest(".htip-btn");
    if (b && !pinned) show(b);
  });
  document.addEventListener("mouseout", e => {
    const b = e.target.closest && e.target.closest(".htip-btn");
    if (b && !pinned && !(e.relatedTarget && (b.contains(e.relatedTarget) || pop.contains(e.relatedTarget)))) hide();
  });
  pop.addEventListener("mouseleave", () => { if (!pinned) hide(); });
  document.addEventListener("focusin", e => { if (e.target.classList && e.target.classList.contains("htip-btn")) show(e.target); });
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".htip-btn");
    if (b) {
      e.preventDefault(); e.stopPropagation();
      if (current === b && pinned) hide(); else { show(b); pinned = true; }
      return;
    }
    if (!pop.contains(e.target)) hide();
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  addEventListener("scroll", () => { if (current) place(current); }, true);
  addEventListener("resize", () => { if (current) place(current); });

  const start = () => scan(document.body);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
