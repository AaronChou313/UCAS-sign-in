import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLessons } from '../wwwroot/course-presentation.mjs';

const day = '2026-11-11';
function course(id, teacher, values = {}) {
  return { id, day, name: '示例课程', teacher, classroom: 'A101', beginTime: '08:30', endTime: '10:10',
    signed: false, canSign: true, status: '未签到', statusKind: 'Unsigned', ...values };
}
function state(courses, ids = courses.map(c => c.id)) {
  return { courses, lessonGroups: [{ day, ids }] };
}

test('multiple teachers share one lesson while keeping original sign-in targets', () => {
  const first = course('1000001', '张老师');
  const second = course('1000002', '李老师');
  const lessons = groupLessons(state([first, second]), day);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].teacher, '张老师、李老师');
  assert.deepEqual(lessons[0].members, [first, second]);
  assert.equal(lessons[0].status, '未签到');
});

test('one successful sign-in keeps the other record unsigned', () => {
  const first = course('1000001', '张老师', { signed: true, canSign: false, status: '已签到', statusKind: 'Signed' });
  const second = course('1000002', '李老师');
  const [lesson] = groupLessons(state([first, second]), day);
  assert.equal(lesson.signed, false);
  assert.equal(lesson.status, '部分已签到（1/2 条）');
  assert.equal(lesson.canSign, true);
  assert.equal(second.signed, false);
  assert.equal(lesson.members[1].id, '1000002');
});

test('fully signed lessons preserve pending verification and block further sign-in', () => {
  const rows = [course('1000001', '张老师'), course('1000002', '李老师')]
    .map(c => ({ ...c, signed: true, canSign: false, status: '已签到 · 待核验', statusKind: 'Signed' }));
  const [lesson] = groupLessons(state(rows), day);
  assert.equal(lesson.signed, true);
  assert.equal(lesson.canSign, false);
  assert.equal(lesson.status, '已签到 · 待核验');
});

test('unknown school status is preserved', () => {
  const rows = [course('1000001', '张老师', { canSign: false, status: '状态待同步', statusKind: 'Unknown' }),
    course('1000002', '李老师')];
  const [lesson] = groupLessons(state(rows), day);
  assert.equal(lesson.status, '状态待同步');
  assert.equal(lesson.members[0].canSign, false);
});

test('distinct core groups and unresolved rows remain separate even with identical names', () => {
  const rows = [course('1000001', '张老师'), course('1000002', '李老师', { beginTime: '13:30' }),
    course('1000003', '王老师')];
  const lessons = groupLessons({ courses: rows, lessonGroups: [{ day, ids: ['1000001'] }, { day, ids: ['1000002'] }] }, day);
  assert.equal(lessons.length, 3);
  assert.equal(lessons[2].id, '1000002');
  assert.ok(lessons.every(lesson => lesson.members.length === 1));
});

test('attendance is projected from current rows when cached core layout retains the same IDs', () => {
  const rows = [course('1000001', '张老师'), course('1000002', '李老师')];
  const data = state(rows);
  assert.equal(groupLessons(data, day)[0].status, '未签到');
  data.courses = rows.map(c => ({ ...c, signed: true, canSign: false, status: '已签到', statusKind: 'Signed' }));
  assert.equal(groupLessons(data, day)[0].status, '已签到');
});
