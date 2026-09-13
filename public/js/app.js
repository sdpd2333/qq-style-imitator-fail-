// State
let currentPage = 'dashboard';
let config = {};
let profiles = [];
let prompts = [];
let currentPromptFile = '';

// Toast
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// Page Navigation
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).style.display = 'block';
  document.querySelector(`[data-page="${page}"]`).classList.add('active');
  currentPage = page;

  if (page === 'dashboard') loadDashboard();
  if (page === 'profiles') refreshProfiles();
  if (page === 'prompts') refreshPrompts();
  if (page === 'config') loadConfig();
  if (page === 'preview') loadPreviewUsers();
}

// Dashboard
async function loadDashboard() {
  try {
    const res = await fetch('/api/profiles');
    profiles = await res.json();
    document.getElementById('stat-profiles').textContent = profiles.length;
    document.getElementById('stat-status').textContent = config.snowluma?.wsUrl ? '已配置' : '未配置';
  } catch (e) {
    console.error(e);
  }
}

// Profiles
async function refreshProfiles() {
  try {
    const res = await fetch('/api/profiles');
    profiles = await res.json();
    renderProfiles();
  } catch (e) {
    showToast('加载失败', true);
  }
}

function renderProfiles() {
  const container = document.getElementById('profiles-list');
  if (profiles.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        <h3>暂无档案</h3>
        <p>请先运行 npm run collect 和 npm run analyze 生成用户档案</p>
      </div>`;
    return;
  }

  let html = '<div class="table-container"><table><thead><tr><th>QQ号</th><th>语气风格</th><th>口头禅</th><th>更新时间</th><th>操作</th></tr></thead><tbody>';
  profiles.forEach(p => {
    html += `<tr>
      <td>${p.targetQQ}</td>
      <td><span class="tag">${p.tone || '自然'}</span></td>
      <td>${(p.catchphrases || []).slice(0, 3).join('、') || '-'}</td>
      <td>${p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '-'}</td>
      <td><button class="btn btn-secondary btn-sm" onclick="viewProfile('${p.targetQQ}')">查看</button></td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

async function viewProfile(qq) {
  try {
    const res = await fetch(`/api/profiles/${qq}`);
    const profile = await res.json();
    document.getElementById('profile-detail').style.display = 'block';
    document.getElementById('profile-content').innerHTML = `
      <div class="code-block">${JSON.stringify(profile, null, 2)}</div>`;
  } catch (e) {
    showToast('加载失败', true);
  }
}

function closeProfileDetail() {
  document.getElementById('profile-detail').style.display = 'none';
}

// Prompts
async function refreshPrompts() {
  try {
    const res = await fetch('/api/prompts');
    prompts = await res.json();
    renderPrompts();
  } catch (e) {
    showToast('加载失败', true);
  }
}

function renderPrompts() {
  const container = document.getElementById('prompts-list');
  if (prompts.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>暂无Prompt文件</h3></div>';
    return;
  }

  let html = '<div class="table-container"><table><thead><tr><th>文件名</th><th>大小</th><th>操作</th></tr></thead><tbody>';
  prompts.forEach(p => {
    html += `<tr>
      <td>${p.name}</td>
      <td>${p.content.length} 字符</td>
      <td><button class="btn btn-secondary btn-sm" onclick="editPrompt('${p.name}')">编辑</button></td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function editPrompt(name) {
  const prompt = prompts.find(p => p.name === name);
  if (!prompt) return;
  currentPromptFile = name;
  document.getElementById('prompt-editor').style.display = 'block';
  document.getElementById('prompt-name').textContent = name;
  document.getElementById('prompt-content').value = prompt.content;
}

function closePromptEditor() {
  document.getElementById('prompt-editor').style.display = 'none';
}

async function savePrompt() {
  try {
    await fetch(`/api/prompts/${currentPromptFile}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: document.getElementById('prompt-content').value })
    });
    showToast('保存成功');
    refreshPrompts();
    closePromptEditor();
  } catch (e) {
    showToast('保存失败', true);
  }
}

// Config
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    document.getElementById('cfg-wsUrl').value = config.snowluma?.wsUrl || '';
    document.getElementById('cfg-accessToken').value = config.snowluma?.accessToken || '';
    document.getElementById('cfg-selfId').value = config.snowluma?.selfId || '';
    document.getElementById('cfg-provider').value = config.llm?.provider || 'openai';
    document.getElementById('cfg-model').value = config.llm?.model || 'gpt-4o-mini';
    document.getElementById('cfg-apiKey').value = config.llm?.apiKey || '';
    document.getElementById('cfg-baseUrl').value = config.llm?.baseUrl || '';
    document.getElementById('cfg-messageCount').value = config.collection?.messageCount || 200;
    document.getElementById('cfg-minMessages').value = config.analysis?.minMessages || 50;
  } catch (e) {
    showToast('加载配置失败', true);
  }
}

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  config = {
    snowluma: {
      wsUrl: document.getElementById('cfg-wsUrl').value,
      accessToken: document.getElementById('cfg-accessToken').value,
      selfId: document.getElementById('cfg-selfId').value
    },
    llm: {
      provider: document.getElementById('cfg-provider').value,
      model: document.getElementById('cfg-model').value,
      apiKey: document.getElementById('cfg-apiKey').value,
      baseUrl: document.getElementById('cfg-baseUrl').value
    },
    collection: {
      messageCount: parseInt(document.getElementById('cfg-messageCount').value),
      saveRaw: false
    },
    analysis: {
      minMessages: parseInt(document.getElementById('cfg-minMessages').value),
      contextWindowSize: 20
    }
  };

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    showToast('配置已保存');
  } catch (e) {
    showToast('保存失败', true);
  }
});

// Preview
async function loadPreviewUsers() {
  try {
    const res = await fetch('/api/profiles');
    profiles = await res.json();
    const select = document.getElementById('preview-user');
    select.innerHTML = '<option value="">-- 选择已分析的用户 --</option>';
    profiles.forEach(p => {
      select.innerHTML += `<option value="${p.targetQQ}">${p.targetQQ} (${p.tone || '自然'})</option>`;
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadPreviewProfile() {}

async function generatePreview() {
  const qq = document.getElementById('preview-user').value;
  const message = document.getElementById('preview-message').value || '你好';

  if (!qq) {
    showToast('请先选择用户', true);
    return;
  }

  const profile = profiles.find(p => p.targetQQ === qq);
  if (!profile) {
    showToast('用户档案不存在', true);
    return;
  }

  try {
    const res = await fetch('/api/preview-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, context: [], message })
    });
    const data = await res.json();
    document.getElementById('preview-result').style.display = 'block';
    document.getElementById('preview-prompt').textContent = data.prompt;
  } catch (e) {
    showToast('生成失败', true);
  }
}

function copyPrompt() {
  const text = document.getElementById('preview-prompt').textContent;
  navigator.clipboard.writeText(text);
  showToast('已复制到剪贴板');
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  loadDashboard();
});
