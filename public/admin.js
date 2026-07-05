/* LeadScout admin — vanilla JS, no build step. Requires an admin session. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

  let plans = [];

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
    if (res.status === 403) { throw new Error('forbidden'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function planOptions(currentId) {
    return plans
      .map((p) => `<option value="${esc(p.id)}"${p.id === currentId ? ' selected' : ''}>${esc(p.name)}</option>`)
      .join('');
  }

  async function loadUsers() {
    const users = await api('/api/admin/users');
    $('users-body').innerHTML = users
      .map(
        (u) =>
          `<tr>` +
          `<td>${esc(u.email)}</td>` +
          `<td>${esc(u.role)}</td>` +
          `<td>${esc(u.planName)}</td>` +
          `<td>${u.unlimited ? '∞' : `${esc(u.scansUsed)}/${esc(u.scansPerPeriod)}`}</td>` +
          `<td>${esc(u.status)}</td>` +
          `<td>${esc(fmtDate(u.expiresAt))}</td>` +
          `<td>` +
          `<select class="grant-plan" data-id="${esc(u.id)}">${planOptions(u.planId)}</select> ` +
          `<input class="grant-days" data-id="${esc(u.id)}" type="number" value="30" min="1" style="width:60px" /> ` +
          `<button class="admin-btn grant-btn" data-id="${esc(u.id)}">Grant</button> ` +
          `<button class="admin-btn danger revoke-btn" data-id="${esc(u.id)}">Revoke</button>` +
          `</td>` +
          `</tr>`,
      )
      .join('');
  }

  function pricingSummary(p) {
    const bits = [];
    const pr = p.pricing || {};
    if (pr.monthly) bits.push(`₹${pr.monthly.price}/mo`);
    if (pr.yearly) bits.push(`₹${pr.yearly.price}/yr`);
    if (pr.lifetime) bits.push(`₹${pr.lifetime.price} one-time`);
    return bits.length ? bits.join(', ') : 'free';
  }

  async function loadPlans() {
    plans = await api('/api/admin/plans');
    $('plans-body').innerHTML = plans
      .map(
        (p) =>
          `<tr>` +
          `<td>${esc(p.id)}</td><td>${esc(p.name)}${p.badge ? ` <span class="admin-note">(${esc(p.badge)})</span>` : ''}</td>` +
          `<td>${esc(p.tier)}</td>` +
          `<td>${p.scansPerPeriod >= 100000 ? '∞' : esc(p.scansPerPeriod)}</td>` +
          `<td>${esc(p.maxRadiusMeters)}</td><td>${esc(p.maxBusinesses)}</td>` +
          `<td>${p.psiAllowed ? '✓' : '—'}</td><td>${esc(p.aiFeatures)}</td>` +
          `<td>${p.prioritySupport ? '✓' : '—'}</td>` +
          `<td>${esc(pricingSummary(p))}</td>` +
          `<td>${p.active ? '✓' : '—'}</td>` +
          `</tr>`,
      )
      .join('');
  }

  async function loadOrders() {
    const orders = await api('/api/admin/orders');
    $('orders-body').innerHTML = orders.length
      ? orders
          .map(
            (o) =>
              `<tr><td>${esc(o.id)}</td><td>${esc(o.userId)}</td><td>${esc(o.planId)}</td>` +
              `<td>${esc(o.amountINR)}</td><td>${esc(o.status)}</td><td>${esc(fmtDate(o.createdAt))}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="6" class="admin-note">No orders yet.</td></tr>';
  }

  $('users-body').addEventListener('click', async (e) => {
    const grant = e.target.closest('.grant-btn');
    const revoke = e.target.closest('.revoke-btn');
    if (grant) {
      const id = grant.dataset.id;
      const planId = document.querySelector(`.grant-plan[data-id="${id}"]`).value;
      const days = Number(document.querySelector(`.grant-days[data-id="${id}"]`).value) || 30;
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId, days }),
        });
        await loadUsers();
      } catch (err) { alert(err.message); }
    } else if (revoke) {
      const id = revoke.dataset.id;
      if (!confirm('Revoke this user to the free plan?')) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
        await loadUsers();
      } catch (err) { alert(err.message); }
    }
  });

  $('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      id: f.id.value.trim(),
      name: f.name.value.trim(),
      tier: Number(f.tier.value) || 0,
      scansPerPeriod: Number(f.scansPerPeriod.value) || 0,
      maxRadiusMeters: Number(f.maxRadiusMeters.value) || 1500,
      maxBusinesses: Number(f.maxBusinesses.value) || 50,
      psiAllowed: f.psiAllowed.checked,
      aiFeatures: f.aiFeatures.value,
      prioritySupport: f.prioritySupport.checked,
      badge: f.badge.value || undefined,
      monthlyPrice: Number(f.monthlyPrice.value) || 0,
      monthlyMrp: Number(f.monthlyMrp.value) || 0,
      yearlyPrice: Number(f.yearlyPrice.value) || 0,
      yearlyMrp: Number(f.yearlyMrp.value) || 0,
      lifetimePrice: Number(f.lifetimePrice.value) || 0,
      lifetimeMrp: Number(f.lifetimeMrp.value) || 0,
      active: f.active.checked,
    };
    try {
      await api('/api/admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      $('plan-msg').textContent = `Saved plan "${body.id}".`;
      await loadPlans();
      await loadUsers();
    } catch (err) {
      $('plan-msg').textContent = err.message;
    }
  });

  $('logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });

  async function boot() {
    let me;
    try {
      me = await api('/api/auth/me');
    } catch {
      location.href = '/login.html';
      return;
    }
    if (me.role !== 'admin') {
      $('gate').textContent = 'Admin access required.';
      return;
    }
    $('gate').hidden = true;
    $('content').hidden = false;
    await loadPlans();
    await loadUsers();
    await loadOrders();
  }
  boot();
})();
