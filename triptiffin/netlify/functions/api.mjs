import { getStore } from "@netlify/blobs";

const REGULAR = [
  ["Pav Bhaji", 225], ["Punjabi Chole", 200], ["Veg. Paneer", 250], ["Mix. Veg sabji", 225],
  ["Veg. Jaipuri", 225], ["Dal Tadka", 200], ["Dal Makhani", 225], ["Manchurian", 225],
  ["Upma", 80], ["Misal Pav", 225], ["Masala Rajma", 200], ["Jeera Rice", 200],
  ["Veg. Fried rice", 225], ["Veg. Biryani", 225], ["Aloo Pyaz Sabji", 200], ["Idli Sambhar", 175],
  ["Dal Khichdi", 200], ["Tava Pulao", 225], ["Poha", 80], ["Green Chutney", 200],
];
const JAIN = [
  ["Pav Bhaji", 225], ["Punjabi Chole", 200], ["Veg. Paneer", 250], ["Veg. Jaipuri", 225],
  ["Dal Tadka", 200], ["Poha", 80], ["Upma", 80], ["Veg. Fried rice", 225], ["Jeera Rice", 200],
  ["Veg. Pulao", 225], ["Idli Sambhar", 175], ["Dal Khichdi", 200], ["Mix Dal", 200], ["Green Chutney", 200],
];

const MAX_ORDERS = 3000;
const MAX_EXPENSES = 3000;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const invoiceId = (n) => `TT-${String(n).padStart(4, "0")}`;

function seed() {
  const items = [
    ...REGULAR.map(([name, price]) => ({ id: `r-${slug(name)}`, name, category: "Regular", price, stock: 50 })),
    ...JAIN.map(([name, price]) => ({ id: `j-${slug(name)}`, name, category: "Jain", price, stock: 50 })),
  ];
  return { items, customers: {}, reminders: [], orders: [], expenses: [], nextInvoice: 1 };
}

// Upgrades data saved by the older version of the app
function normalize(s) {
  s.items ||= [];
  s.customers ||= {};
  s.reminders ||= [];
  s.orders ||= [];
  s.expenses ||= [];
  let n = s.nextInvoice || 1;
  for (const o of s.orders) {
    if (!o.no) { o.no = n++; o.invoice = invoiceId(o.no); }
    if (!o.payment) o.payment = "Cash";
  }
  s.nextInvoice = n;
  return s;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (msg, status = 400) => json({ error: msg }, status);

const publicState = (s) => ({
  items: s.items,
  customers: s.customers,
  reminders: s.reminders,
  orders: s.orders,
  expenses: s.expenses,
});

export default async (req) => {
  // Optional PIN protection (set APP_PIN in Netlify environment variables)
  const pin = Netlify.env.get("APP_PIN");
  if (pin && req.headers.get("x-pin") !== pin) return fail("Invalid PIN", 401);

  const store = getStore({ name: "triptiffin", consistency: "strong" });
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");

  let state = await store.get("state", { type: "json" });
  if (!state) {
    state = seed();
    await store.setJSON("state", state);
  }
  state = normalize(state);
  const save = () => store.setJSON("state", state);

  if (req.method === "GET" && route === "data") return json(publicState(state));
  if (req.method !== "POST") return fail("Not found", 404);

  let body = {};
  try { body = await req.json(); } catch { /* empty body */ }

  switch (route) {
    case "checkout": {
      const phone = String(body.phone || "").replace(/\D/g, "");
      if (phone.length < 10) return fail("Enter a valid phone number (at least 10 digits).");
      const name = String(body.name || "").trim().slice(0, 60) || "Walk-in Customer";
      const payment = body.payment === "UPI" ? "UPI" : "Cash";
      const lines = Array.isArray(body.items) ? body.items : [];
      if (!lines.length) return fail("Cart is empty.");

      let total = 0;
      const orderLines = [];
      for (const l of lines) {
        const item = state.items.find((i) => i.id === l.id);
        const qty = Math.floor(Number(l.qty));
        if (!item || !(qty > 0)) return fail("Invalid item in cart.");
        if (item.stock < qty) return fail(`Not enough stock for ${item.name} (${item.category}). Only ${item.stock} left.`);
        total += item.price * qty;
        orderLines.push({ id: item.id, name: item.name, category: item.category, price: item.price, qty });
      }
      // all validated — apply
      for (const l of orderLines) state.items.find((i) => i.id === l.id).stock -= l.qty;

      const c = state.customers[phone] || { name, phone, totalSpent: 0, orders: 0 };
      if (name !== "Walk-in Customer") c.name = name;
      c.totalSpent += total;
      c.orders += 1;
      c.lastOrder = new Date().toISOString();
      state.customers[phone] = c;

      const no = state.nextInvoice++;
      const order = {
        no, invoice: invoiceId(no), at: c.lastOrder, phone, name: c.name, total, payment, lines: orderLines,
      };
      state.orders.push(order);
      if (state.orders.length > MAX_ORDERS) state.orders = state.orders.slice(-MAX_ORDERS);

      await save();
      return json({ ok: true, total, order, state: publicState(state) });
    }

    case "item": {
      const name = String(body.name || "").trim().slice(0, 60);
      const price = Number(body.price);
      const stock = Math.floor(Number(body.stock));
      const category = body.category === "Jain" ? "Jain" : "Regular";
      if (!name) return fail("Item name is required.");
      if (!(price >= 0) || !(stock >= 0)) return fail("Price and stock must be 0 or more.");
      if (body.id) {
        const it = state.items.find((i) => i.id === body.id);
        if (!it) return fail("Item not found.", 404);
        Object.assign(it, { name, price, stock, category });
      } else {
        state.items.push({ id: `i${Date.now()}`, name, category, price, stock });
      }
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "item-delete": {
      state.items = state.items.filter((i) => i.id !== body.id);
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "expense": {
      const amount = Number(body.amount);
      const note = String(body.note || "").trim().slice(0, 120);
      const category = String(body.category || "Other").trim().slice(0, 30) || "Other";
      const payment = body.payment === "UPI" ? "UPI" : "Cash";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : new Date().toISOString().slice(0, 10);
      if (!note) return fail("Enter a description for the expense.");
      if (!(amount > 0)) return fail("Enter a valid expense amount.");
      state.expenses.push({
        id: `e${Date.now()}`, date, category, note, amount, payment, created: new Date().toISOString(),
      });
      if (state.expenses.length > MAX_EXPENSES) state.expenses = state.expenses.slice(-MAX_EXPENSES);
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "expense-delete": {
      state.expenses = state.expenses.filter((e) => e.id !== body.id);
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "reminder": {
      const text = String(body.text || "").trim().slice(0, 200);
      if (!text) return fail("Reminder text is required.");
      state.reminders.push({
        id: `m${Date.now()}`, text, due: body.due || "", done: false, created: new Date().toISOString(),
      });
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "reminder-toggle": {
      const r = state.reminders.find((x) => x.id === body.id);
      if (r) r.done = !r.done;
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "reminder-delete": {
      state.reminders = state.reminders.filter((x) => x.id !== body.id);
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    case "reset": {
      state = seed();
      await save();
      return json({ ok: true, state: publicState(state) });
    }

    default:
      return fail("Not found", 404);
  }
};

export const config = { path: "/api/*" };
