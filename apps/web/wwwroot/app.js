import { groupLessons } from './course-presentation.mjs';

const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toastElement = document.querySelector('#toast');
let state;
let page = 'today';
let busy = false;
let search = '';
let qrTimer;
let toastTimer;
let dialogRevision = 0;
let reminderAccount;
const notified = new Set();
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const icons = {
  today: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18m-13 5h3"/>',
  schedule: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12M15 9v12"/>',
  courses: '<path d="M4 3h6a3 3 0 0 1 3 3v15a4 4 0 0 0-4-3H3V3h1Zm9 3a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 3"/>',
  records: '<path d="M8 3h8l4 4v14H4V3h4m8 0v5h4M8 12h8M8 16h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3" fill="currentColor"/><circle cx="16" cy="17" r="3" fill="currentColor"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  location: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM21 12h-9v9M3 12h6M12 3v6"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.today}</svg>`;
}
function h(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function dateFrom(day) { return new Date(`${day}T12:00:00+08:00`); }
function dayKey(date) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function addDays(day, count) {
  const date = dateFrom(day);
  date.setDate(date.getDate() + count);
  return dayKey(date);
}
function monday(day) { return addDays(day, -((dateFrom(day).getDay() + 6) % 7)); }
function dateLabel(day) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(dateFrom(day)); }
function timeLabel(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未同步'; }
function statusBadge(course) {
  const kind = course.statusKind === 'Signed' ? 'signed' : ['Unsigned', 'Partial'].includes(course.statusKind) ? 'unsigned' : 'unknown';
  return `<span class="badge ${kind}">${course.signed ? icon('check') : ''}${h(course.status)}</span>`;
}
function brand() { return '<div class="brand"><img src="/brand.png" alt=""><div><strong>果壳签到</strong><span>国科大轻新课堂</span></div></div>'; }
function empty(title, description = '') { return `<div class="empty">${icon('today')}<h3>${h(title)}</h3><p class="small-text">${h(description)}</p></div>`; }
function toast(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 5500);
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-UCAS-Generation': state?.generation || '', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
async function perform(path, body = {}, method = 'POST') {
  if (busy) return false;
  busy = true;
  document.body.insertAdjacentHTML('beforeend', '<div class="busy-indicator" role="status" aria-label="正在处理"></div>');
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    state = await api(path, { method, body });
    if (state.signError || state.message) toast(state.signError || state.message);
    render();
    return true;
  } catch (error) {
    toast(error.message);
    const formError = dialog.open ? dialog.querySelector('.form-error') : root.querySelector('.form-error');
    if (formError) formError.textContent = error.message;
    return false;
  } finally {
    busy = false;
    document.querySelector('.busy-indicator')?.remove();
    document.querySelectorAll('button').forEach(button => { button.disabled = button.dataset.disabled === 'true'; });
  }
}
function buttonDisabled(disabled) { return disabled ? 'disabled data-disabled="true"' : ''; }
function loginForm() {
  return `<form class="form" data-form="login">
    <label class="field">SEP 邮箱或轻新课堂学号<input name="username" autocomplete="username" placeholder="请输入邮箱或学号" required maxlength="200"></label>
    <label class="field">密码<input name="password" type="password" autocomplete="current-password" placeholder="请输入学校账号密码" required maxlength="500"></label>
    <label class="check-label"><input type="checkbox" name="remember">记住密码</label>
    <p class="form-error" role="alert"></p>
    <div class="form-actions"><button class="primary" type="submit">连接学校账号</button></div>
  </form>`;
}
function renderLogin() {
  root.innerHTML = `<main class="login-page"><section class="login-main">${brand()}
    <div class="login-content"><h1>连接学校账号</h1><p>使用 SEP 邮箱或轻新课堂学号登录。</p>
    ${loginForm()}<button class="quiet" data-action="demo" style="width:100%;margin-top:12px">体验演示 ${icon('arrow')}</button></div>
    </section></main>`;
}

function render() {
  if (!state.isConnected) { renderLogin(); return; }
  const nav = [['today', '今日'], ['schedule', '课表'], ['courses', '课程'], ['records', '记录'], ['settings', '设置'], ['account', '账户']];
  const name = state.isDemo ? '演示账户' : state.activeAccount?.name || '学校账户';
  const content = ({ today: todayPage, schedule: schedulePage, courses: coursesPage, records: recordsPage, settings: settingsPage, account: accountPage })[page]();
  root.innerHTML = `<div class="shell"><aside class="sidebar">${brand()}<nav class="navigation" aria-label="主导航">${nav.map(([id, title]) => `<button data-page="${id}" class="${page === id ? 'active' : ''}" ${page === id ? 'aria-current="page"' : ''}>${icon(id)}<span>${title}</span></button>`).join('')}</nav>
    <div class="sidebar-bottom"><button class="account-button" data-page="account"><span class="avatar">${h(name.slice(0, 1))}</span><span><strong class="account-name">${h(name)}</strong><span class="small-text">${state.isDemo ? '本地示例数据' : h(state.activeAccount?.id)}</span></span></button></div></aside>
    <main class="workspace">${state.isDemo ? '<div class="demo-banner"><span>演示模式</span><button class="quiet small" data-action="exit-demo">退出演示</button></div>' : ''}
    ${state.activeAccount?.requiresLogin ? '<div class="notice">学校会话已过期，请重新连接账号。<button class="quiet small" data-action="login">重新登录</button></div>' : ''}
    ${content}</main></div>`;
}
function pageTop(title, subtitle, actions = '') {
  return `<header class="page-top"><div><h1>${h(title)}</h1>${subtitle ? `<p>${h(subtitle)}</p>` : ''}</div><div class="top-actions">${actions}</div></header>`;
}
function refreshButton(action = 'refresh') { return `<button data-action="${action}" aria-label="刷新">${icon('refresh')}<span> 刷新</span></button>`; }
function notice(message) { return message ? `<div class="notice" role="status">${h(message)}</div>` : ''; }
function dayStrip() {
  const first = monday(state.selectedDate);
  return `<div class="day-strip" aria-label="本周日期">${Array.from({ length: 7 }, (_, i) => {
    const day = addDays(first, i);
    const inRange = !state.viewedDateRange || day >= state.viewedDateRange.begin && day <= state.viewedDateRange.end;
    return `<button data-date="${day}" class="${day === state.selectedDate ? 'selected' : ''}" ${buttonDisabled(!inRange)} ${day === state.selectedDate ? 'aria-pressed="true"' : 'aria-pressed="false"'}><span class="weekday">周${weekdays[dateFrom(day).getDay()]}</span><span class="day-number">${dateFrom(day).getDate()}</span><span class="today-dot" style="visibility:${day === state.today ? 'visible' : 'hidden'}"></span></button>`;
  }).join('')}</div>`;
}
function lesson(course) {
  return `<article class="lesson"><div class="lesson-time"><strong>${h(course.beginTime.slice(0, 5))}</strong><span>${h(course.endTime.slice(0, 5))}</span></div><div>
    <h3>${h(course.name)}</h3><div class="lesson-meta"><span>${icon('account')}${h(course.teacher || '教师暂未提供')}</span><span>${icon('location')}${h(course.classroom || '教室暂未提供')}</span></div>
    <div class="lesson-bottom">${statusBadge(course)}<div class="lesson-actions"><button class="small quiet" data-action="lesson-detail" data-id="${h(course.id)}" data-day="${h(course.day)}">详情</button><button class="small" data-action="lesson-qr" data-id="${h(course.id)}" data-day="${h(course.day)}">${icon('qr')} 二维码</button><button class="small primary" data-action="lesson-sign" data-id="${h(course.id)}" data-day="${h(course.day)}" ${buttonDisabled(!course.canSign)}>${course.signed ? '已签到' : course.members.length > 1 ? '签到明细' : '签到'}</button></div></div></div></article>`;
}
function todayPage() {
  const courses = groupLessons(state, state.selectedDate);
  const signed = courses.filter(c => c.signed).length;
  return `${pageTop(state.selectedDate === state.today ? '今日课程' : dateLabel(state.selectedDate), `${dateLabel(state.selectedDate)}，星期${weekdays[dateFrom(state.selectedDate).getDay()]}${state.viewedSemester ? ` · ${state.viewedSemester.name}` : ''}`, refreshButton())}
    ${notice(state.notice || state.signError)}${dayStrip()}<div class="day-body"><section><div class="section-heading"><h2>${courses.length ? `${courses.length} 节课程` : '课程安排'}</h2><span class="muted small-text">${signed ? `${signed} 节已签到` : '按上课时间排列'}</span></div>
    <div class="lesson-list">${courses.length ? courses.map(lesson).join('') : empty('这一天没有课程', state.notice ? '请重新同步学校课表。' : '可以切换日期，查看其他课程安排。')}</div><p class="sync-note">${state.isDemo ? '演示数据 · 签到不会提交到学校' : `学校状态更新于 ${timeLabel(state.lastSyncAt)}`}</p></section>
    <aside class="summary"><h2>这一天的安排</h2><div class="summary-line"><span class="muted">课程总数</span><strong>${courses.length} 节</strong></div><div class="summary-line"><span class="muted">已签到</span><strong>${signed} 节</strong></div><div class="summary-line"><span class="muted">待处理</span><strong>${courses.length - signed} 节</strong></div><div class="summary-divider"></div>
    <div class="auto-state">${icon('clock')}自动签到${h(state.autoSignSettingsStatus)}</div><button class="quiet small" data-page="settings">签到设置 ${icon('arrow')}</button></aside></div>`;
}
function schedulePage() {
  const week = state.scheduleMode === 'Week';
  const first = monday(state.selectedDate);
  return `${pageTop('我的课表', `${state.viewedSemester?.name || '课程安排'}${state.scheduleWeekNumber ? ` · 第 ${state.scheduleWeekNumber} 周` : ''}`, refreshButton())}
    ${notice(state.scheduleError || state.notice)}<div class="toolbar"><div class="segmented"><button data-action="mode-day" class="${!week ? 'active' : ''}">日</button><button data-action="mode-week" class="${week ? 'active' : ''}">周</button></div>
    <button class="icon-button" data-action="prev-week" aria-label="上一周" ${buttonDisabled(!state.previousScheduleWeek)}>‹</button><button class="icon-button" data-action="next-week" aria-label="下一周" ${buttonDisabled(!state.nextScheduleWeek)}>›</button><button class="quiet" data-action="today" ${buttonDisabled(!state.canReturnToToday)}>今天</button><span class="spacer"></span>
    <label class="small-text">日期 <input aria-label="选择课表日期" type="date" id="schedule-date" value="${h(state.selectedDate)}" ${state.viewedDateRange ? `min="${h(state.viewedDateRange.begin)}" max="${h(state.viewedDateRange.end)}"` : ''}></label>
    ${state.scheduleSemesters.length ? `<select id="semester" aria-label="选择学期">${state.scheduleSemesters.map(s => `<option value="${h(s.id)}" ${s.id === state.viewedSemester?.id ? 'selected' : ''}>${h(s.name)}</option>`).join('')}</select>` : ''}</div>
    ${week ? `<div class="week-scroll"><div class="week-grid">${Array.from({ length: 7 }, (_, i) => {
      const day = addDays(first, i);
      const courses = groupLessons(state, day);
      return `<section class="week-column"><h2 class="week-head ${day === state.today ? 'today' : ''}">周${weekdays[dateFrom(day).getDay()]} · ${dateFrom(day).getDate()}</h2>${courses.map(c => `<button class="week-lesson" data-action="lesson-detail" data-id="${h(c.id)}" data-day="${h(c.day)}"><strong>${h(c.name)}</strong><span>${h(c.timeRange)}</span><span>${h(c.classroom || '教室暂未提供')}</span><span>${h(c.teacher)}</span></button>`).join('')}</section>`;
    }).join('')}</div></div>` : `${dayStrip()}<div class="lesson-list">${groupLessons(state, state.selectedDate).map(lesson).join('') || empty('这一天没有课程')}</div>`}
    <p class="sync-note">${state.isDemo ? '演示课表' : `课表同步于 ${timeLabel(state.scheduleUpdatedAt)} · 日视图可核实签到状态`}</p>`;
}
function catalogItems() {
  const query = search.trim().toLocaleLowerCase();
  const courses = state.catalogCourses.filter(c => `${c.name} ${c.number} ${c.teacher}`.toLocaleLowerCase().includes(query));
  return courses.length ? `<div class="catalog">${courses.map(c => `<article class="catalog-item"><h3>${h(c.name)}</h3><p>${h(c.number)} · ${h(c.teacher || '教师暂未提供')}</p><p>${h(c.classroom || '教室暂未提供')}</p><div class="row spread"><span class="muted small-text">${h(c.beginDate)} — ${h(c.endDate)}</span><button class="small" data-action="attendance" data-id="${h(c.id)}">查看考勤</button></div></article>`).join('')}</div>` : empty(search ? '没有匹配的课程' : '暂无课程目录', search ? '换个课程名称、编号或教师试试。' : '点击刷新，从学校获取当前学期课程。');
}
function coursesPage() {
  return `${pageTop('课程目录', state.selectedSemester?.name || '当前学期的全部课程', refreshButton('refresh-catalog'))}${notice(state.catalogError)}<div class="toolbar"><input type="search" id="course-search" value="${h(search)}" placeholder="搜索课程、编号或教师" aria-label="搜索课程"><span class="muted small-text">共 ${state.catalogCourses.length} 门</span></div><div id="catalog-results">${catalogItems()}</div><p class="sync-note">更新于 ${timeLabel(state.catalogUpdatedAt)}</p>`;
}
function recordsPage() {
  return `${pageTop('签到记录', '当前账户的本地操作结果')}
    ${state.records.length ? `<div class="records"><table><thead><tr><th>课程</th><th>操作时间</th><th>结果</th></tr></thead><tbody>${state.records.map(r => `<tr><td>${h(r.courseName)}</td><td>${h(timeLabel(r.date))}</td><td><span class="badge ${r.succeeded ? 'signed' : 'unknown'}">${h(r.message)}</span></td></tr>`).join('')}</tbody></table></div>` : empty('还没有签到记录', '完成课程签到后，可以在这里查看操作结果。')}
    ${state.autoSignHistory.length ? `<section class="settings-section"><h2>自动签到执行记录</h2><div class="records"><table><thead><tr><th>课程</th><th>时间</th><th>结果</th></tr></thead><tbody>${state.autoSignHistory.map(r => `<tr><td>${h(r.courseName || '课程')}</td><td>${h(timeLabel(r.classStartAt))}</td><td>${h(r.message)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
}
function toggle(name, checked, label) {
  return `<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} aria-label="${h(label)}"><span></span></label>`;
}
function settingRow(title, description, control) { return `<div class="settings-row"><div><strong>${title}</strong>${description ? `<p>${description}</p>` : ''}</div>${control}</div>`; }
function settingsPage() {
  const p = state.preferences;
  return `${pageTop('设置', '')}${notice(state.autoSignError)}<section class="settings-section"><h2>自动签到</h2><div class="settings-rows">
    ${settingRow('自动签到', h(state.autoSignRuntimeStatus), toggle('autoSign', state.autoSignRunning, '自动签到'))}
    </div></section><form data-form="preferences"><section class="settings-section"><h2>手动签到</h2><div class="settings-rows">
    ${settingRow('签到前确认', '', toggle('confirm', p.confirmBeforeSign, '手动签到前确认'))}
    </div></section><section class="settings-section"><h2>课程提醒</h2><div class="settings-rows">
    ${settingRow('课前通知', '', toggle('reminders', p.remindersEnabled, '启用浏览器课前提醒'))}
    ${settingRow('提前提醒', '', `<select name="lead" aria-label="提前提醒时间">${[5, 10, 15, 30].map(n => `<option value="${n}" ${n === p.reminderLeadMinutes ? 'selected' : ''}>${n} 分钟</option>`).join('')}</select>`)}
    </div></section><button type="submit" class="primary">保存偏好</button></form>
    `;
}

function accountPage() {
  return `${pageTop('账户管理', '', '<button class="primary" data-action="login">添加账户</button>')}
    ${state.isDemo ? notice('当前正在使用演示账户，可添加学校账号开始使用。') : ''}
    <section class="settings-section"><div class="settings-rows">${state.accounts.length ? state.accounts.map(a => `<article class="account-item"><h3>${h(a.name || '学校账户')} ${!state.isDemo && a.id === state.activeAccount?.id ? '<span class="badge">当前账户</span>' : ''}</h3><p class="muted small-text">${h(a.id)} · ${h(a.loginUsername)}</p><div class="row"><button class="small" data-action="switch-account" data-id="${h(a.id)}">${a.requiresLogin ? '切换并重新登录' : '切换账户'}</button><button class="small danger" data-action="remove-account" data-id="${h(a.id)}">从本机移除</button></div></article>`).join('') : empty('尚未连接学校账号', '使用 SEP 邮箱或轻新课堂学号连接。')}</div></section>
    `;
}
function openDialog(title, content) {
  clearTimeout(qrTimer);
  dialogRevision++;
  dialog.innerHTML = `<header class="dialog-head"><h2 id="dialog-title">${h(title)}</h2><button class="quiet" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></header>${content}`;
  if (!dialog.open) dialog.showModal();
}
function closeDialog() {
  clearTimeout(qrTimer);
  dialogRevision++;
  if (dialog.open) dialog.close();
}
function currentCourse(id, day) { return state.courses.find(c => c.id === id && c.day === day); }
function currentLesson(id, day) { return groupLessons(state, day).find(course => course.id === id); }
function showLessonEntries(course, mode = 'detail') {
  if (!course) return;
  const heading = mode === 'qr' ? '选择签到二维码' : mode === 'sign' ? '签到明细' : course.name;
  openDialog(heading, `<p class="dialog-subtitle">${h(course.name)} · ${h(course.day)} · ${h(course.timeRange)}</p>
    
    <div class="settings-rows" style="margin-top:18px">${course.members.map(member => `<div class="settings-row wrap"><div><strong>${h(member.teacher || '教师暂未提供')}</strong><p>课次 ID ${h(member.id)}</p>${statusBadge(member)}</div><div class="lesson-actions"><button class="small" data-action="qr" data-id="${h(member.id)}" data-day="${h(member.day)}">二维码</button><button class="small primary" data-action="sign" data-id="${h(member.id)}" data-day="${h(member.day)}" ${buttonDisabled(!member.canSign)}>${member.signed ? '已签到' : '签到'}</button></div></div>`).join('')}</div>
    <div class="dialog-actions">${course.courseId ? `<button data-action="attendance" data-id="${h(course.courseId)}">学校考勤</button><button data-action="course-preferences" data-id="${h(course.courseId)}">课程偏好</button>` : ''}<button data-action="open-day" data-day="${h(course.day)}">查看当天课程</button></div>`);
}
async function requestSign(course) {
  if (!course?.canSign) return;
  const { id, day } = course;
  if (course.confirmation) {
    openDialog('确认课程签到', `<p>${h(course.name)}</p><p class="muted">${h(day)} · ${h(course.timeRange)}</p><p class="muted small-text">${h(course.teacher)} · 课次 ID ${h(id)}</p><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="primary" data-action="confirm-sign" data-id="${h(id)}" data-day="${h(day)}">确认签到</button></div>`);
  } else {
    closeDialog();
    await perform('/sign', { id, day });
  }
}
function showDetail(course) {
  if (!course) return;
  openDialog(course.name, `<dl class="detail-facts"><dt>日期</dt><dd>${h(course.day)}</dd><dt>上课时间</dt><dd>${h(course.timeRange)}</dd><dt>授课教师</dt><dd>${h(course.teacher || '暂未提供')}</dd><dt>教室</dt><dd>${h(course.classroom || '暂未提供')}</dd><dt>签到状态</dt><dd>${statusBadge(course)}</dd></dl>
    <div class="dialog-actions">${course.courseId ? `<button data-action="attendance" data-id="${h(course.courseId)}">学校考勤</button><button data-action="course-preferences" data-id="${h(course.courseId)}">课程偏好</button>` : ''}<button data-action="open-day" data-day="${h(course.day)}">查看当天课程</button><button data-action="qr" data-id="${h(course.id)}" data-day="${h(course.day)}">二维码</button><button class="primary" data-action="sign" data-id="${h(course.id)}" data-day="${h(course.day)}" ${buttonDisabled(!course.canSign)}>${course.signed ? '已签到' : '签到'}</button></div>`);
}
async function showQr(course) {
  if (!course) return;
  openDialog('课程二维码', `<p class="dialog-subtitle">${h(course.name)} · ${h(course.timeRange)}</p><div class="qr-panel"><div class="qr-placeholder" role="status">正在同步学校时间…</div></div>`);
  const revision = dialogRevision;
  async function update() {
    try {
      const qr = await api(`/qr?id=${encodeURIComponent(course.id)}&day=${encodeURIComponent(course.day)}`);
      if (!dialog.open || revision !== dialogRevision) return;
      dialog.querySelector('.qr-panel').innerHTML = `<img src="${h(qr.image)}" alt="${h(course.name)}的动态签到二维码"><p>${qr.isDemo ? '演示二维码 · 无签到效力' : '已同步学校时间 · 每次有效期结束自动更新'}</p><p>更新于 ${h(new Date().toLocaleTimeString('zh-CN', { hour12: false }))}</p>`;
      const wait = Math.max(500, new Date(qr.expiresAt).getTime() - Date.now());
      qrTimer = setTimeout(update, wait);
    } catch (error) {
      if (!dialog.open || revision !== dialogRevision) return;
      dialog.querySelector('.qr-panel').innerHTML = `<p class="form-error">${h(error.message)}</p><button data-action="qr" data-id="${h(course.id)}" data-day="${h(course.day)}">重新同步</button>`;
    }
  }
  await update();
}
async function showAttendance(id) {
  const course = state.catalogCourses.find(c => c.id === id) || state.courses.find(c => c.courseId === id);
  openDialog('学校考勤', `<p class="dialog-subtitle">${h(course?.name || '课程')}</p><div id="attendance-content" role="status">正在获取学校考勤…</div>`);
  const revision = dialogRevision;
  try {
    const result = await api(`/attendance/${encodeURIComponent(id)}`);
    if (!dialog.open || revision !== dialogRevision) return;
    const summary = result.summary;
    dialog.querySelector('#attendance-content').innerHTML = `${notice(result.error)}${summary ? `<div class="row" style="margin-bottom:20px"><span class="badge signed">已签到 ${summary.signedCount}</span><span class="badge unsigned">未签到 ${summary.unsignedCount}</span></div><div class="attendance-list">${summary.records.map(r => `<div class="attendance-row"><span>${h(r.day)}<br><span class="muted">${h(r.beginTime)} — ${h(r.endTime)}</span></span><span>${r.signStatusKnown !== true ? '状态待同步' : r.signed ? '已签到' : '未签到'}</span></div>`).join('') || empty('暂无课次明细')}</div><p class="sync-note">更新于 ${h(timeLabel(result.updatedAt))}</p>` : '<p class="muted">学校暂未提供考勤数据。</p>'}`;
  } catch (error) {
    if (dialog.open && revision === dialogRevision) dialog.querySelector('#attendance-content').textContent = error.message;
  }
}
function showCoursePreferences(id) {
  const p = state.preferences.courses[id] || {};
  const options = [['Inherit', '跟随账户'], ['Enabled', '启用'], ['Disabled', '停用']];
  const select = (name, value) => `<select name="${name}" aria-label="课程签到确认">${options.map(([v, t]) => `<option value="${v}" ${(value || 'Inherit') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  openDialog('课程偏好', `<form data-form="course-preferences" data-id="${h(id)}"><div class="settings-rows">${settingRow('禁用本课程签到', '', toggle('disabled', p.signInDisabled, '禁用本课程签到'))}${settingRow('手动签到前确认', '', select('confirmation', p.confirmation))}</div><div class="dialog-actions"><button class="primary" type="submit">保存课程偏好</button></div></form>`);
}
async function chooseDate(day, week = state.scheduleMode === 'Week') {
  await perform('/date', { date: day, week });
}
async function navigate(next) {
  if (busy) return;
  page = next;
  if (next === 'today') {
    await chooseDate(state.today, false);
  } else if (next === 'schedule') {
    await chooseDate(state.selectedDate, true);
  } else if (next === 'courses') {
    await perform('/catalog', { force: false });
  } else render();
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled || busy) return;
  if (button.dataset.page) { await navigate(button.dataset.page); return; }
  if (button.dataset.date) { await chooseDate(button.dataset.date); return; }
  const { action, id, day } = button.dataset;
  if (!action) return;
  switch (action) {
    case 'demo': page = 'today'; await perform('/demo'); break;
    case 'exit-demo': closeDialog(); page = 'today'; await perform('/demo/exit'); break;
    case 'refresh': await perform('/refresh'); break;
    case 'refresh-catalog': await perform('/catalog', { force: true }); break;
    case 'login': openDialog('连接学校账号', loginForm()); break;
    case 'close-dialog': closeDialog(); break;
    case 'mode-day': await chooseDate(state.selectedDate, false); break;
    case 'mode-week': await chooseDate(state.selectedDate, true); break;
    case 'today': await chooseDate(state.today); break;
    case 'prev-week': await chooseDate(state.previousScheduleWeek); break;
    case 'next-week': await chooseDate(state.nextScheduleWeek); break;
    case 'lesson-detail': {
      const course = currentLesson(id, day);
      if (course?.members.length > 1) showLessonEntries(course);
      else showDetail(course);
      break;
    }
    case 'lesson-qr': {
      const course = currentLesson(id, day);
      if (course?.members.length > 1) showLessonEntries(course, 'qr');
      else await showQr(course);
      break;
    }
    case 'lesson-sign': {
      const course = currentLesson(id, day);
      if (course?.members.length > 1) { showLessonEntries(course, 'sign'); break; }
      await requestSign(currentCourse(id, day));
      break;
    }
    case 'detail': showDetail(currentCourse(id, day)); break;
    case 'qr': await showQr(currentCourse(id, day)); break;
    case 'attendance': await showAttendance(id); break;
    case 'course-preferences': showCoursePreferences(id); break;
    case 'open-day': closeDialog(); page = 'today'; await chooseDate(day, false); break;
    case 'sign': await requestSign(currentCourse(id, day)); break;
    case 'confirm-sign': closeDialog(); await perform('/sign', { id, day }); break;
    case 'switch-account': {
      if (await perform(`/accounts/${encodeURIComponent(id)}/switch`)) {
        page = 'today'; render();
        if (state.activeAccount?.requiresLogin) openDialog('重新连接学校账号', loginForm());
      }
      break;
    }
    case 'remove-account':
      openDialog('移除本机账户', `<p>移除账户 ${h(id)} 的本机会话、课表、偏好与操作记录。</p><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="danger" data-action="confirm-remove" data-id="${h(id)}">确认移除</button></div>`);
      break;
    case 'confirm-remove': closeDialog(); await perform(`/accounts/${encodeURIComponent(id)}`, undefined, 'DELETE'); break;
  }
});
document.addEventListener('change', async event => {
  if (busy) return;
  if (event.target.name === 'autoSign') {
    const input = event.target;
    const p = state.preferences;
    input.disabled = true;
    const success = await perform('/preferences', { autoSign: input.checked, reminders: p.remindersEnabled,
      confirmBeforeSign: p.confirmBeforeSign, reminderLeadMinutes: p.reminderLeadMinutes }, 'PUT');
    if (!success) { input.checked = state.autoSignRunning; input.disabled = false; }
  }
  if (event.target.id === 'schedule-date') await chooseDate(event.target.value);
  if (event.target.id === 'semester') await perform('/semester', { id: event.target.value });
});
document.addEventListener('input', event => {
  if (event.target.id === 'course-search') {
    search = event.target.value;
    document.querySelector('#catalog-results').innerHTML = catalogItems();
  }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  if (busy) return;
  const data = new FormData(form);
  switch (form.dataset.form) {
    case 'login': {
      const success = await perform('/login', { username: data.get('username'), password: data.get('password'), remember: data.has('remember') });
      if (success) { form.reset(); closeDialog(); page = 'today'; render(); }
      break;
    }
    case 'preferences':
      if (data.has('reminders') && 'Notification' in window && Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') toast('浏览器通知未获允许，可在浏览器设置中开启。');
      }
      await perform('/preferences', { autoSign: state.autoSignRunning, reminders: data.has('reminders'), confirmBeforeSign: data.has('confirm'), reminderLeadMinutes: Number(data.get('lead')) }, 'PUT');
      break;
    case 'course-preferences': {
      const id = form.dataset.id;
      const success = await perform(`/courses/${encodeURIComponent(id)}/preferences`, { ...state.preferences.courses[id], signInDisabled: data.has('disabled'), confirmation: data.get('confirmation') }, 'PUT');
      if (success) closeDialog();
      break;
    }
  }
});
dialog.addEventListener('close', () => {
  if (!dialog.open) { clearTimeout(qrTimer); dialogRevision++; }
});
function notifyReminders() {
  if (!state.isConnected || state.isDemo || !('Notification' in window) || Notification.permission !== 'granted') return;
  const account = state.activeAccount?.id;
  if (reminderAccount !== account) { notified.clear(); reminderAccount = account; }
  for (const reminder of state.reminders) {
    const delta = Date.now() - new Date(reminder.at).getTime();
    if (delta >= 0 && delta < 60000 && !notified.has(reminder.id)) {
      new Notification(`果壳签到 · ${reminder.title}`, { body: reminder.body, tag: reminder.id, icon: '/brand.png' });
      notified.add(reminder.id);
    }
  }
}
async function poll() {
  if (!state) return;
  notifyReminders();
  if (busy || dialog.open) return;
  try {
    const previous = state;
    state = await api('/state');
    if (previous.generation !== state.generation) { toast('当前账户已更新'); render(); }
    else if (!['INPUT', 'SELECT'].includes(document.activeElement?.tagName) && page !== 'settings') render();
    notifyReminders();
  } catch (error) { toast(`本地服务连接中断。${error.message}`); }
}
async function start() {
  try { state = await api('/state'); render(); }
  catch (error) {
    root.innerHTML = `<main class="loading-screen"><h2>暂时无法连接本地服务</h2><p>${h(error.message)}</p><button id="retry-connect">重新连接</button></main>`;
    document.querySelector('#retry-connect').addEventListener('click', start);
  }
}
setInterval(poll, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
start();
