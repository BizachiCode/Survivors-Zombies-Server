// Admin panel: plain JavaScript, no build step, no external requests. Talks to /admin/api with the admin token
// (kept in sessionStorage only: it disappears with the tab). Everything shown is inserted as text, never as HTML.
"use strict";

(() => {
  const TOKEN_KEY = "ctd_admin_token";
  const ASSIGN_AS_PROPERTY = new Set(["value", "checked", "disabled", "readOnly", "selected", "type", "placeholder", "rows", "min", "max", "step", "id", "name", "required", "title", "href", "maxLength", "autocomplete"]);

  let token = readToken();
  let meta = { currencies: [], items: [] };

  // ------------------------------------------------------------------ helpers
  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  }
  function storeToken(value) {
    try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: the token lives in memory only */ }
  }

  /** Creates an element: h("div", { class: "x", onClick: fn }, child, "text", [children]...). */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (ASSIGN_AS_PROPERTY.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const $ = (selector, root = document) => root.querySelector(selector);
  const pad = (n) => String(n).padStart(2, "0");
  const fmtTime = (unix) => {
    if (!unix) return "-";
    const d = new Date(unix * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  };
  const fmtDuration = (seconds) => {
    const d = Math.floor(seconds / 86400), hh = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d}d ${hh}h` : hh > 0 ? `${hh}h ${m}m` : `${m}m`;
  };
  const amounts = (bag) => Object.entries(bag || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
  const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (value) => (value ? new Date(value).toISOString() : "");

  function toast(message, isError = false) {
    const el = h("div", { class: `toast${isError ? " error" : ""}` }, message);
    $("#toasts").append(el);
    setTimeout(() => el.remove(), isError ? 9000 : 3500);
  }

  class ApiError extends Error {
    constructor(code, data) {
      const issues = Array.isArray(data?.issues) ? ` (${data.issues.map((i) => `${i.path || "payload"}: ${i.message}`).join("; ")})` : "";
      super(`${code}${data?.message && data.message !== code ? `: ${data.message}` : ""}${issues}`);
      this.code = code;
      this.data = data;
    }
  }

  async function api(method, path, body) {
    const response = await fetch(`/admin/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    if (response.status === 401) {
      token = "";
      storeToken("");
      throw new ApiError("ADMIN_UNAUTHORIZED", data);
    }
    if (response.status === 429) throw new ApiError("Too many failed attempts, try again later", data);
    if (!response.ok || data.ok === false) throw new ApiError(data.error || `HTTP ${response.status}`, data);
    return data;
  }

  /** Runs `work`, shows a toast with `success` or the error, and disables `button` meanwhile. */
  async function act(button, success, work) {
    if (button) button.disabled = true;
    try {
      const result = await work();
      if (success) toast(success);
      return result;
    } catch (error) {
      if (error.code === "ADMIN_UNAUTHORIZED") showLogin("The session ended, sign in again.");
      else toast(error.message || String(error), true);
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  }

  // ------------------------------------------------------------------ reusable form parts
  /** Currency inputs plus a list of item rows. get() -> { currencies, items } with positive integers only. */
  function amountsEditor(currencies) {
    const currencyInputs = currencies.map((id) => ({ id, input: h("input", { type: "number", min: 0, step: 1, placeholder: "0" }) }));
    const rows = h("div");
    const datalist = h("datalist", { id: `items-${Math.random().toString(36).slice(2)}` }, meta.items.map((id) => h("option", { value: id })));
    const addRow = (itemId = "", amount = "") => {
      const row = h("div", { class: "item-row" },
        h("input", { placeholder: "item id", value: itemId, autocomplete: "off" }),
        h("input", { type: "number", min: 1, step: 1, placeholder: "amount", value: amount }),
        h("button", { class: "btn small", type: "button", onClick: () => row.remove() }, "Remove"));
      $("input", row).setAttribute("list", datalist.id);
      rows.append(row);
    };
    const el = h("div", null,
      currencyInputs.length ? h("div", { class: "fields" }, currencyInputs.map(({ id, input }) => h("label", null, id, input))) : null,
      h("fieldset", null, h("legend", null, "Items"), rows, datalist,
        h("p", null, h("button", { class: "btn small", type: "button", onClick: () => addRow() }, "+ item"))));
    return {
      el,
      addRow,
      get() {
        const result = { currencies: {}, items: {} };
        for (const { id, input } of currencyInputs) {
          const value = Number(input.value);
          if (input.value !== "" && value > 0) result.currencies[id] = Math.floor(value);
        }
        for (const row of rows.children) {
          const [name, amount] = row.querySelectorAll("input");
          const value = Number(amount.value);
          if (name.value.trim() && value > 0) result.items[name.value.trim()] = (result.items[name.value.trim()] || 0) + Math.floor(value);
        }
        return result;
      },
      set(bag) {
        for (const { id, input } of currencyInputs) input.value = bag?.currencies?.[id] ?? "";
        rows.replaceChildren();
        for (const [itemId, value] of Object.entries(bag?.items || {})) addRow(itemId, value);
      },
    };
  }

  /** A text that may be given in several languages: get() -> string (English only) or { en, pt?, es?, zh?, ja?, ko? }. */
  const LANGUAGES = [["en", "English"], ["pt", "Portuguese"], ["es", "Spanish"], ["zh", "Chinese (Simplified)"], ["ja", "Japanese"], ["ko", "Korean"]];
  function localizedField(label, value, multiline) {
    const make = (lang) => (multiline ? h("textarea", { placeholder: lang }) : h("input", { placeholder: lang, value: "" }));
    const inputs = Object.fromEntries(LANGUAGES.map(([lang]) => [lang, make(lang)]));
    const set = (text) => {
      const source = typeof text === "string" ? { en: text } : text || {};
      for (const lang of Object.keys(inputs)) inputs[lang].value = source[lang] || "";
    };
    set(value);
    return {
      el: h("fieldset", null, h("legend", null, `${label} (en required; other languages optional)`),
        ...LANGUAGES.map(([lang, name]) => h("label", null, name, inputs[lang]))),
      get() {
        const result = { en: inputs.en.value.trim() };
        for (const [lang] of LANGUAGES.slice(1)) if (inputs[lang].value.trim()) result[lang] = inputs[lang].value.trim();
        return Object.keys(result).length > 1 ? result : result.en;
      },
      set,
    };
  }

  const badge = (text, kind = "") => h("span", { class: `badge ${kind}` }, text);
  const table = (headers, rows, options = {}) =>
    h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, headers.map((title, i) => h("th", { class: options.numeric?.includes(i) ? "num" : "" }, title)))),
      h("tbody", null, rows.length ? rows : h("tr", null, h("td", { colSpan: headers.length, class: "muted" }, options.empty || "Nothing here.")))));

  // ------------------------------------------------------------------ views
  async function dashboardView() {
    const { players, purchasesToday, server } = await api("GET", "/dashboard");
    updateMaintenanceBadge(server.maintenance);
    const stat = (label, value) => h("div", { class: "stat" }, h("div", { class: "value" }, value), h("div", { class: "label" }, label));
    const toggle = h("button", { class: `btn ${server.maintenance ? "" : "danger"}`, type: "button" }, server.maintenance ? "Turn maintenance off" : "Turn maintenance on");
    toggle.addEventListener("click", async () => {
      const next = !server.maintenance;
      if (next && !confirm("Turn maintenance ON? Nobody can sign in or refresh a session until it is turned off (or the server restarts).")) return;
      if (await act(toggle, next ? "Maintenance is on" : "Maintenance is off", () => api("POST", "/maintenance", { enabled: next }))) route();
    });
    return h("div", null,
      h("h1", null, "Dashboard"),
      h("div", { class: "grid stats" },
        stat("Players", players.total), stat("Active today", players.activeToday), stat("Active 7 days", players.activeWeek), stat("New today", players.newToday),
        stat("Purchases today", purchasesToday.total), stat("Refunded today", purchasesToday.refunded)),
      h("div", { class: "grid two" },
        h("div", { class: "card" }, h("h2", null, "Purchases today by product"),
          table(["Product", "Purchases", "Refunded"], purchasesToday.byProduct.map((p) => h("tr", null, h("td", null, p.productId), h("td", { class: "num" }, p.count), h("td", { class: "num" }, p.refunded))),
            { numeric: [1, 2], empty: "No purchases today." })),
        h("div", { class: "card" }, h("h2", null, "Server"),
          h("dl", { class: "kv" },
            h("dt", null, "Version"), h("dd", null, server.version),
            h("dt", null, "Environment"), h("dd", null, server.nodeEnv),
            h("dt", null, "Uptime"), h("dd", null, fmtDuration(server.uptimeSec)),
            h("dt", null, "Server time"), h("dd", null, fmtTime(server.serverTimeUnix)),
            h("dt", null, "Maintenance"), h("dd", null, server.maintenance ? badge("ON", "warn") : badge("off", "ok"))),
          h("p", null, toggle))));
  }

  async function playersView(userId) {
    return userId ? playerDetailView(userId) : playerSearchView();
  }

  function playerRow(player) {
    const status = player.isBanned ? badge("banned", "danger") : player.isGuest ? badge("guest") : badge("account", "ok");
    return h("tr", { class: "click", onClick: () => { location.hash = `#/players/${player.userId}`; } },
      h("td", { class: "mono" }, player.publicCode), h("td", null, player.nickname || "-"), h("td", { class: "num" }, player.level ?? "-"),
      h("td", null, player.email || "-"), h("td", null, status), h("td", null, fmtTime(player.lastLoginAtUnix)));
  }

  async function playerSearchView() {
    const results = h("div");
    const input = h("input", { placeholder: "Public code (8 hex), nickname prefix, email or user id", autocomplete: "off" });
    const search = async (term) => {
      if (!term.trim()) return;
      const { players } = await api("GET", `/players?q=${encodeURIComponent(term.trim())}`);
      results.replaceChildren(table(["Code", "Nickname", "Level", "Email", "Status", "Last login"], players.map(playerRow), { numeric: [2], empty: "No player matches." }));
    };
    const form = h("form", { class: "row", onSubmit: (event) => { event.preventDefault(); act(null, "", () => search(input.value)); } },
      h("div", { class: "spacer" }, input), h("button", { class: "btn primary", type: "submit" }, "Search"));
    return h("div", null, h("h1", null, "Players"), h("div", { class: "card" }, form), h("div", { class: "card" }, results));
  }

  async function playerDetailView(userId) {
    const data = await api("GET", `/players/${userId}`);
    const { player, profile, ban, wallet, items } = data;
    const reload = () => route();

    // grant / remove
    const adjustEditor = amountsEditor(Object.keys(wallet));
    const mode = h("select", null, h("option", { value: "grant" }, "Grant"), h("option", { value: "remove" }, "Remove (never below zero)"));
    const note = h("input", { placeholder: "Note for the audit trail", maxLength: 200 });
    const adjustButton = h("button", { class: "btn primary", type: "submit" }, "Apply");
    const adjustForm = h("form", { onSubmit: async (event) => {
      event.preventDefault();
      const value = adjustEditor.get();
      if (!Object.keys(value.currencies).length && !Object.keys(value.items).length) return toast("Enter at least one amount", true);
      const result = await act(adjustButton, "", () => api("POST", `/players/${userId}/adjust`, { mode: mode.value, ...value, note: note.value }));
      if (!result) return;
      const short = result.shortfall && (Object.keys(result.shortfall.currencies).length || Object.keys(result.shortfall.items).length) ? ` (not available: ${amounts(result.shortfall.currencies)} ${amounts(result.shortfall.items)})` : "";
      toast(`${result.mode === "grant" ? "Granted" : "Removed"}: ${amounts(result.applied.currencies)} | ${amounts(result.applied.items)}${short}`);
      reload();
    } }, h("label", null, "Action", mode), adjustEditor.el, h("label", null, "Note", note), adjustButton);

    // mail
    const mailEditor = amountsEditor(Object.keys(wallet));
    const mailTitle = localizedField("Title", "", false);
    const mailBody = localizedField("Body", "", true);
    const mailSender = h("input", { value: "Pirate Cove", maxLength: 64 });
    const mailExpires = h("input", { type: "number", min: 0, step: 1, value: 0 });
    const mailButton = h("button", { class: "btn primary", type: "submit" }, "Send mail");
    const mailForm = h("form", { onSubmit: async (event) => {
      event.preventDefault();
      const attachments = mailEditor.get();
      const body = { sender: mailSender.value.trim() || "Pirate Cove", title: mailTitle.get(), body: mailBody.get(), attachments: { ...attachments, exp: 0 }, expiresInDays: Number(mailExpires.value) || 0 };
      if (await act(mailButton, "Mail sent", () => api("POST", `/players/${userId}/mail`, body))) reload();
    } }, h("div", { class: "fields" }, h("label", null, "Sender", mailSender), h("label", null, "Expires after (days, 0 = never)", mailExpires)),
    mailTitle.el, mailBody.el, h("h3", null, "Attachments (optional)"), mailEditor.el, mailButton);

    // ban
    const banReason = h("input", { placeholder: "Reason (shown to the player)", maxLength: 255 });
    const banHours = h("input", { type: "number", min: 0, step: 1, value: 0 });
    const banButton = h("button", { class: "btn danger", type: "submit" }, "Ban");
    const banForm = h("form", { onSubmit: async (event) => {
      event.preventDefault();
      const hours = Math.floor(Number(banHours.value) || 0);
      if (!confirm(`Ban ${player.nickname || player.publicCode}${hours > 0 ? ` for ${hours} hours` : " permanently"}? Their sessions end immediately.`)) return;
      const body = { reason: banReason.value, ...(hours > 0 ? { durationHours: hours } : {}) };
      if (await act(banButton, "Player banned", () => api("POST", `/players/${userId}/ban`, body))) reload();
    } }, h("label", null, "Reason", banReason), h("label", null, "Duration in hours (0 = permanent)", banHours), banButton);
    const unbanButton = h("button", { class: "btn", type: "button" }, "Unban");
    unbanButton.addEventListener("click", async () => {
      if (await act(unbanButton, "Player unbanned", () => api("POST", `/players/${userId}/unban`))) reload();
    });

    const purchaseRows = data.purchases.map((p) => {
      const refund = h("button", { class: "btn small danger", type: "button" }, "Refund");
      refund.addEventListener("click", async () => {
        const reason = prompt("Reason for the refund (audit trail):", "");
        if (!reason || !reason.trim()) return;
        if (!confirm(`Refund ${p.productId}? What it granted (${amounts(p.granted.currencies)} | ${amounts(p.granted.items)}) is taken back as far as the player still has it.`)) return;
        const result = await act(refund, "", () => api("POST", "/refunds", { store: p.store, transactionId: p.transactionId, reason: reason.trim() }));
        if (result) { toast(`Refund ${result.refund.status}`); reload(); }
      });
      return h("tr", null,
        h("td", null, fmtTime(p.purchasedAtUnix)), h("td", null, p.productId, p.quantity > 1 ? ` x${p.quantity}` : ""), h("td", null, `${p.store} / ${p.environment}`),
        h("td", { class: "mono" }, p.orderId || p.transactionId.slice(0, 18)),
        h("td", null, p.status === "refunded" ? [badge("refunded", "warn"), h("div", { class: "muted" }, `${fmtTime(p.refundedAtUnix)} - ${p.refundReason || ""}`),
          p.refundShortfall ? h("div", { class: "muted" }, `not taken back: ${amounts(p.refundShortfall.currencies)} | ${amounts(p.refundShortfall.items)}`) : null] : badge("granted", "ok")),
        h("td", null, p.status === "granted" ? refund : null));
    });

    return h("div", null,
      h("p", null, h("a", { href: "#/players" }, "< Players")),
      h("div", { class: "row between" }, h("h1", null, player.nickname || "(no nickname)"), ban.banned ? badge("BANNED", "danger") : badge(player.isGuest ? "guest" : "account", "ok")),
      h("div", { class: "grid two" },
        h("div", { class: "card" }, h("h2", null, "Profile"), h("dl", { class: "kv" },
          h("dt", null, "Public code"), h("dd", { class: "mono" }, player.publicCode),
          h("dt", null, "User id"), h("dd", { class: "mono" }, player.userId),
          h("dt", null, "Email"), h("dd", null, player.email || "-"),
          h("dt", null, "Level"), h("dd", null, profile ? `${profile.level} (exp ${profile.exp})` : "-"),
          h("dt", null, "Avatar"), h("dd", null, profile?.avatarId || "-"),
          h("dt", null, "Friends"), h("dd", null, data.friends),
          h("dt", null, "Created"), h("dd", null, fmtTime(player.createdAtUnix)),
          h("dt", null, "Last login"), h("dd", null, fmtTime(player.lastLoginAtUnix)),
          h("dt", null, "Ban"), h("dd", null, ban.banned ? `${ban.reason || "no reason"} - until ${ban.untilUnix ? fmtTime(ban.untilUnix) : "forever"}` : "-"))),
        h("div", { class: "card" }, h("h2", null, "Wallet and items"),
          h("dl", { class: "kv" }, Object.entries(wallet).map(([k, v]) => [h("dt", null, k), h("dd", null, v)])),
          h("h3", null, "Items"),
          Object.keys(items).length ? h("dl", { class: "kv" }, Object.entries(items).map(([k, v]) => [h("dt", null, k), h("dd", null, v)])) : h("p", { class: "muted" }, "No items."))),
      h("div", { class: "grid two" },
        h("div", { class: "card" }, h("h2", null, "Grant or remove"), adjustForm),
        h("div", { class: "card" }, h("h2", null, "Send mail"), mailForm)),
      h("div", { class: "card" }, h("h2", null, "Ban"), ban.banned ? h("div", { class: "row" }, h("span", null, "This player is banned."), unbanButton) : null, banForm),
      h("div", { class: "card" }, h("h2", null, "Purchases"),
        table(["When", "Product", "Store", "Order", "Status", ""], purchaseRows, { empty: "No purchases." })),
      h("div", { class: "card" }, h("h2", null, "Latest battles"),
        table(["When", "Mode", "Stage", "Outcome", "Stars", "Kills"], data.battles.map((b) => h("tr", null, h("td", null, fmtTime(b.createdAtUnix)), h("td", null, b.mode), h("td", null, b.stageId), h("td", null, b.outcome), h("td", { class: "num" }, b.stars), h("td", { class: "num" }, b.kills))),
          { numeric: [4, 5], empty: "No battles." })),
      h("div", { class: "card" }, h("h2", null, "Admin history"), auditTable(data.audit)));
  }

  function auditTable(entries) {
    return table(["When", "Action", "Target", "IP", "Details"], entries.map((e) =>
      h("tr", null, h("td", null, fmtTime(e.atUnix)), h("td", null, e.action), h("td", { class: "mono" }, e.target || "-"), h("td", { class: "mono" }, e.ip), h("td", null, h("pre", { class: "json" }, JSON.stringify(e.payload))))),
    { empty: "Nothing recorded." });
  }

  async function auditView() {
    const { entries } = await api("GET", "/audit?limit=100");
    return h("div", null, h("h1", null, "Audit"), h("p", { class: "muted" }, "Every mutating admin action, newest first."), h("div", { class: "card" }, auditTable(entries)));
  }

  // --- content editors (news and mail broadcasts share the list + form layout)
  function editorView({ title, path, listKey, columns, newEntry, buildForm }) {
    return async () => {
      const data = await api("GET", path);
      const entries = data[listKey];
      const holder = h("div");
      const list = h("div", { class: "card" });
      const refresh = () => route();

      const open = (entry, isNew) => {
        const form = buildForm(entry, isNew);
        const save = h("button", { class: "btn primary", type: "submit" }, isNew ? "Create" : "Save");
        const remove = h("button", { class: "btn danger", type: "button" }, "Delete");
        remove.addEventListener("click", async () => {
          if (!confirm(`Delete ${entry.id}?`)) return;
          if (await act(remove, "Deleted", () => api("DELETE", `${path}/${encodeURIComponent(entry.id)}`))) refresh();
        });
        const element = h("form", { class: "card", onSubmit: async (event) => {
          event.preventDefault();
          let payload;
          try { payload = form.get(); } catch (error) { return toast(error.message, true); }
          const result = await act(save, isNew ? "Created" : "Saved", () => isNew ? api("POST", path, payload) : api("PUT", `${path}/${encodeURIComponent(entry.id)}`, payload));
          if (result) refresh();
        } }, h("h2", null, isNew ? `New ${title}` : `Edit ${entry.id}`), form.el,
        h("div", { class: "row" }, save, isNew ? null : remove, h("button", { class: "btn", type: "button", onClick: () => holder.replaceChildren() }, "Close")));
        holder.replaceChildren(element);
        element.scrollIntoView({ block: "start" });
      };

      list.append(h("div", { class: "row between" }, h("h2", null, "Entries"), h("button", { class: "btn primary", type: "button", onClick: () => open(newEntry(), true) }, "New")),
        table(columns.map((c) => c.title), entries.map((entry) => h("tr", { class: "click", onClick: () => open(entry, false) }, columns.map((c) => h("td", null, c.cell(entry))))), { empty: "Nothing yet." }));
      return h("div", null, h("h1", null, title), holder, list);
    };
  }

  const textOf = (text) => (typeof text === "string" ? text : text?.en || "");

  const newsView = editorView({
    title: "News",
    path: "/news",
    listKey: "items",
    columns: [
      { title: "Id", cell: (e) => e.id }, { title: "Title", cell: (e) => textOf(e.title) },
      { title: "Published", cell: (e) => e.publishedAt }, { title: "Expires", cell: (e) => e.expiresAt || "-" }, { title: "Pinned", cell: (e) => (e.pinned ? "yes" : "") },
    ],
    newEntry: () => ({ id: "", title: "", body: "", image: "", url: "", publishedAt: new Date().toISOString(), pinned: false }),
    buildForm(entry, isNew) {
      const id = h("input", { value: entry.id, readOnly: !isNew, required: true, placeholder: "letters, digits, _ . -", maxLength: 64 });
      const title = localizedField("Title", entry.title, false);
      const body = localizedField("Body", entry.body, true);
      const image = h("input", { value: entry.image || "", maxLength: 64, placeholder: "art key" });
      const url = h("input", { value: entry.url || "", maxLength: 512, placeholder: "https://..." });
      const published = h("input", { type: "datetime-local", value: toLocalInput(entry.publishedAt), required: true });
      const expires = h("input", { type: "datetime-local", value: toLocalInput(entry.expiresAt) });
      const pinned = h("input", { type: "checkbox", checked: !!entry.pinned });
      return {
        el: h("div", null, h("div", { class: "fields" }, h("label", null, "Id", id), h("label", null, "Image key", image), h("label", null, "Link", url),
          h("label", null, "Published (your local time)", published), h("label", null, "Expires (optional)", expires)),
        h("label", { class: "inline-check" }, pinned, "Pinned"), title.el, body.el),
        get() {
          const item = { id: id.value.trim(), title: title.get(), body: body.get(), image: image.value.trim(), url: url.value.trim(), publishedAt: fromLocalInput(published.value), pinned: pinned.checked };
          if (expires.value) item.expiresAt = fromLocalInput(expires.value);
          return item;
        },
      };
    },
  });

  const mailView = editorView({
    title: "Mail broadcasts",
    path: "/mail-broadcasts",
    listKey: "broadcasts",
    columns: [
      { title: "Id", cell: (e) => e.id }, { title: "Title", cell: (e) => textOf(e.title) }, { title: "Sender", cell: (e) => e.sender },
      { title: "Attachments", cell: (e) => `${amounts(e.attachments?.currencies)} | ${amounts(e.attachments?.items)}${e.attachments?.exp ? ` | exp ${e.attachments.exp}` : ""}` },
      { title: "Window", cell: (e) => `${e.startsAt || "always"} -> ${e.endsAt || "no end"}` },
    ],
    newEntry: () => ({ id: "", sender: "Pirate Cove", title: "", body: "", attachments: { currencies: {}, items: {}, exp: 0 }, expiresAfterDays: 30 }),
    buildForm(entry, isNew) {
      const id = h("input", { value: entry.id, readOnly: !isNew, required: true, placeholder: "letters, digits, _ . -", maxLength: 64 });
      const sender = h("input", { value: entry.sender || "Pirate Cove", maxLength: 64 });
      const title = localizedField("Title", entry.title, false);
      const body = localizedField("Body", entry.body, true);
      const attachments = amountsEditor(meta.currencies);
      attachments.set(entry.attachments);
      const exp = h("input", { type: "number", min: 0, step: 1, value: entry.attachments?.exp || 0 });
      const starts = h("input", { type: "datetime-local", value: toLocalInput(entry.startsAt) });
      const ends = h("input", { type: "datetime-local", value: toLocalInput(entry.endsAt) });
      const lifetime = h("input", { type: "number", min: 0, step: 1, value: entry.expiresAfterDays ?? 30 });
      return {
        el: h("div", null, h("div", { class: "fields" }, h("label", null, "Id", id), h("label", null, "Sender", sender),
          h("label", null, "Delivered from (optional, local time)", starts), h("label", null, "Delivered until (optional)", ends), h("label", null, "Days in the inbox (0 = never expires)", lifetime)),
        title.el, body.el, h("h3", null, "Attachments"), attachments.el, h("label", null, "Experience points", exp)),
        get() {
          const item = { id: id.value.trim(), sender: sender.value.trim() || "Pirate Cove", title: title.get(), body: body.get(),
            attachments: { ...attachments.get(), exp: Math.max(0, Math.floor(Number(exp.value) || 0)) }, expiresAfterDays: Math.max(0, Math.floor(Number(lifetime.value) || 0)) };
          if (starts.value) item.startsAt = fromLocalInput(starts.value);
          if (ends.value) item.endsAt = fromLocalInput(ends.value);
          return item;
        },
      };
    },
  });

  // ------------------------------------------------------------------ shell
  const ROUTES = { dashboard: dashboardView, players: playersView, news: newsView, mail: mailView, audit: auditView };
  let renderId = 0;

  function updateMaintenanceBadge(on) {
    $("#maintenance-badge").hidden = !on;
  }

  async function route() {
    if (!token) return showLogin();
    const [, name = "dashboard", arg] = location.hash.split("/");
    const view = ROUTES[name] || dashboardView;
    for (const link of document.querySelectorAll("#nav a")) link.classList.toggle("active", link.dataset.route === (ROUTES[name] ? name : "dashboard"));
    const mine = ++renderId;
    try {
      const element = await view(arg);
      if (mine === renderId) $("#view").replaceChildren(element);
    } catch (error) {
      if (error.code === "ADMIN_UNAUTHORIZED") return showLogin("The session ended, sign in again.");
      if (mine === renderId) $("#view").replaceChildren(h("div", { class: "card" }, h("h2", null, "Could not load this page"), h("p", { class: "error" }, error.message)));
    }
  }

  function showLogin(message) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    const error = $("#login-error");
    error.hidden = !message;
    error.textContent = message || "";
    $("#login-token").focus();
  }

  function signOut() {
    token = "";
    storeToken("");
    showLogin();
  }

  async function start() {
    try {
      meta = await api("GET", "/meta");
    } catch (error) {
      return showLogin(error.code === "ADMIN_UNAUTHORIZED" ? "Wrong token." : error.message);
    }
    $("#login").hidden = true;
    $("#app").hidden = false;
    route();
  }

  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    token = $("#login-token").value.trim();
    $("#login-token").value = "";
    storeToken(token);
    start();
  });
  $("#sign-out").addEventListener("click", signOut);
  window.addEventListener("hashchange", route);

  if (token) start(); else showLogin();
})();
