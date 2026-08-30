const $ = (id) => document.getElementById(id);
const els = {
  auth: $('auth'), token: $('token'), state: $('state'), submissions: $('submissions'),
  grant: $('grant'), account: $('account'), finish: $('finish'), action: $('grant-action'),
};
let token = '';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'request_failed');
  return body;
}

function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(rows) {
  if (!rows.length) {
    els.submissions.replaceChildren(el('p', 'The review queue is empty.'));
    return;
  }
  els.submissions.replaceChildren(...rows.map((item) => {
    const article = el('article');
    const copy = el('div');
    copy.append(el('h3', item.title), el('small', item.account), el('small', item.id));
    copy.append(el('p', item.description));
    const palette = el('div', undefined, 'palette');
    for (const key of ['steel', 'dark', 'trim']) {
      const swatch = el('div', undefined, 'swatch');
      swatch.style.background = item.manifest?.[key] ?? '#000000';
      swatch.title = `${key}: ${item.manifest?.[key] ?? '?'}`;
      palette.append(swatch);
    }
    copy.append(palette, el('small', item.note || 'No reviewer note.'), el('b', item.status, 'status'));
    const actions = el('div', undefined, 'actions');
    const note = el('textarea');
    note.placeholder = 'Reviewer note';
    note.value = item.note ?? '';
    actions.append(note);
    for (const status of ['reviewing', 'approved', 'rejected', 'disabled']) {
      const button = el('button', status);
      button.type = 'button';
      if (status === 'rejected' || status === 'disabled') button.className = 'danger';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api('/api/review/decision', {
            method: 'POST', body: JSON.stringify({ id: item.id, status, note: note.value }),
          });
          await load();
        } catch (err) {
          els.state.textContent = err.message;
          button.disabled = false;
        }
      });
      actions.append(button);
    }
    article.append(copy, actions);
    return article;
  }));
}

async function load() {
  els.state.textContent = 'loading…';
  const body = await api('/api/review/submissions');
  render(body.submissions ?? []);
  els.state.textContent = `${body.submissions?.length ?? 0} in queue`;
}

els.auth.addEventListener('submit', async (event) => {
  event.preventDefault();
  token = els.token.value.trim();
  els.token.value = '';
  try { await load(); } catch (err) { els.state.textContent = err.message; }
});

els.grant.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/review/grant', {
      method: 'POST',
      body: JSON.stringify({ account: els.account.value.trim(), finish: els.finish.value, action: els.action.value }),
    });
    els.state.textContent = `${els.action.value} applied`;
  } catch (err) { els.state.textContent = err.message; }
});
