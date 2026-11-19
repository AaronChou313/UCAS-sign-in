using Microsoft.AspNetCore.DataProtection;
using UCASSignIn.Core;

namespace UCASSignIn.Web;

public sealed class WebAccountStore(string path, IDataProtectionProvider provider) : EncryptedAccountStore(path)
{
    readonly IDataProtector protector = provider.CreateProtector("UCASSignIn.Web.Accounts.v1");
    protected override byte[] Protect(byte[] plain) => protector.Protect(plain);
    protected override byte[] Unprotect(byte[] cipher) => protector.Unprotect(cipher);
}

public sealed class WebReminders : IReminderScheduler
{
    public IReadOnlyList<Reminder> Items { get; private set; } = [];
    public Task<bool> RequestPermissionAsync() => Task.FromResult(true);
    public Task ReplaceAsync(IReadOnlyList<Reminder> reminders)
    {
        Items = reminders.ToArray();
        return Task.CompletedTask;
    }
}

public sealed class WebRuntime(AccountCoordinator coordinator, WebReminders reminders)
{
    readonly SemaphoreSlim gate = new(1);
    // The upstream coordinator expects UI-context serialization, including async continuations.
    readonly ConcurrentExclusiveSchedulerPair scheduler = new(TaskScheduler.Default, 1);

    public async Task<T> RunAsync<T>(Func<AccountCoordinator, Task<T>> operation, Guid? generation = null)
    {
        await gate.WaitAsync();
        try
        {
            return await Task.Factory.StartNew(async () =>
            {
                if (generation is { } expected && expected != coordinator.Generation)
                    throw new BadHttpRequestException("账户已切换，请刷新页面后重试", StatusCodes.Status409Conflict);
                return await operation(coordinator);
            }, CancellationToken.None, TaskCreationOptions.DenyChildAttach, scheduler.ExclusiveScheduler).Unwrap();
        }
        finally { gate.Release(); }
    }

    public Task<object> ChangeAsync(Guid generation, Func<AccountCoordinator, Task> operation) => RunAsync(async c =>
    {
        c.SetMessage(null);
        if (c.SignInError is { } error) c.AcknowledgeSignInError(error.Id);
        await operation(c);
        return Snapshot(c);
    }, generation);

    public Task<object> StateAsync() => RunAsync(c => Task.FromResult(Snapshot(c)));

    public static Course FindCourse(AccountCoordinator c, string id, string day) =>
        c.Courses.FirstOrDefault(x => x.Id == id && x.Day == CourseTime.NormalizeDay(day))
        ?? throw new BadHttpRequestException("课次已变更，请刷新课表", StatusCodes.Status404NotFound);

    object Snapshot(AccountCoordinator c) => new
    {
        c.Generation, c.IsDemo, c.IsConnected, c.SelectedDate, c.ScheduleMode,
        c.Message, SignError = c.SignInError?.Message, c.LastSyncAt,
        Notice = c.CourseNotice(c.SelectedDate), c.ScheduleError, c.CatalogError,
        c.CatalogUpdatedAt, c.ScheduleUpdatedAt, c.ViewedSemester, c.SelectedSemester,
        c.ScheduleWeekNumber, c.ScheduleWeekCount, c.PreviousScheduleWeek, c.NextScheduleWeek,
        c.ViewedDateRange, c.CanReturnToToday,
        Accounts = c.Accounts.Select(a => new { a.Id, a.Session.Name, a.RequiresLogin, a.LoginUsername }).ToArray(),
        ActiveAccount = c.IsDemo || c.ActiveAccount is null ? null : new
        {
            c.ActiveAccount.Id, c.ActiveAccount.Session.Name, c.ActiveAccount.RequiresLogin,
            c.ActiveAccount.LoginUsername, RememberPassword = c.ActiveAccount.Credentials is not null
        },
        Courses = c.Courses.OrderBy(course => course.Start).ThenBy(course => course.Id).Select(course => new
        {
            course.Id, Day = DisplayDay(course.Day), course.Name, course.Teacher, course.Classroom,
            BeginTime = CourseTime.Display(course.BeginTime), EndTime = CourseTime.Display(course.EndTime),
            course.TimeRange, course.Signed, CourseId = c.PreferenceId(course),
            CanSign = c.CanSign(course), Status = c.AttendanceLabel(course),
            StatusKind = c.AttendanceStatusFor(course).ToString(),
            Confirmation = c.EffectiveConfirmation(c.PreferenceId(course))
        }).ToArray(),
        LessonGroups = c.WeekSchedule().Blocks.SelectMany(block => block.Entries)
            .Concat(c.WeekSchedule().Unplaced).Select(entry => new
            {
                Day = entry.DisplayDate,
                Ids = entry.Courses.Select(course => course.Id).ToArray()
            }).ToArray(),
        c.ScheduleSemesters, c.Semesters,
        CatalogCourses = c.CatalogCourses.Select(course => course with
        {
            BeginDate = DisplayDay(course.BeginDate), EndDate = DisplayDay(course.EndDate)
        }).ToArray(),
        c.Records, c.Preferences,
        AutoSignRunning = c.Preferences.AutoSignIsRunning,
        c.AutoSignSettingsStatus, c.AutoSignRuntimeStatus, c.AutoSignError,
        AutoSignPlans = c.AutoSignPlans.Select(p => new
        {
            p.Key, p.Course.Name, Day = DisplayDay(p.Course.Day), p.Course.TimeRange, p.PlannedAt,
            p.StageTitle, p.Reason, p.NextAction, p.IsParticipating
        }).ToArray(),
        c.AutoSignHistory,
        Reminders = reminders.Items,
        Today = CourseTime.Today()
    };

    public static string DisplayDay(string day) => CourseTime.NormalizeDay(day) is { } normalized
        ? CourseTime.Date(normalized).ToString("yyyy-MM-dd") : day;
}

public sealed class SignInWorker(WebRuntime runtime, ILogger<SignInWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await runtime.RunAsync(async c => { await c.TickAsync(allowBackground: true); return true; });
                }
                catch (Exception e) when (!stoppingToken.IsCancellationRequested)
                {
                    logger.LogError(e, "后台签到检查失败");
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
