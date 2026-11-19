// Group membership comes from the shared core's schedule layout. Original rows remain the sign-in targets.
export function groupLessons(state, day) {
  const courses = state.courses.filter(course => course.day === day);
  const byId = new Map(courses.map(course => [course.id, course]));
  const groups = (state.lessonGroups || []).filter(group => group.day === day)
    .map(group => group.ids.map(id => byId.get(id)).filter(Boolean)).filter(group => group.length);
  const groupedIds = new Set(groups.flatMap(group => group.map(course => course.id)));
  groups.push(...courses.filter(course => !groupedIds.has(course.id)).map(course => [course]));
  return groups.map(members => {
    const first = members[0];
    const signedCount = members.filter(course => course.signed).length;
    const signed = signedCount === members.length;
    const partial = signedCount > 0 && !signed;
    const unknown = members.some(course => course.statusKind !== 'Signed' && course.statusKind !== 'Unsigned');
    const pending = members.some(course => course.status.includes('待核验'));
    return {
      ...first,
      members,
      teacher: [...new Set(members.map(course => course.teacher.trim()).filter(Boolean))].join('、'),
      signed,
      canSign: members.some(course => course.canSign),
      statusKind: signed ? 'Signed' : partial ? 'Partial' : unknown ? 'Unknown' : 'Unsigned',
      status: partial ? `部分已签到（${signedCount}/${members.length} 条）`
        : signed ? pending ? '已签到 · 待核验' : '已签到' : unknown ? '状态待同步' : '未签到',
    };
  }).sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id));
}
