namespace UCASSignIn.Core.Tests;

public sealed class AutoSignBeforeClassTests
{
    static async Task<(AccountCoordinator Model, FakeClock Clock, FakeSchool School, MemoryData Data)> Setup(
        int minutesBefore = 31, bool enabled = true)
    {
        var now = TestData.Now.AddMinutes(-minutesBefore);
        var account = TestData.Account() with { Settings = new(AutoSignRunning: enabled, AutoSignEnabled: enabled,
            AutoSignRunningSince: now.AddHours(-1), AutoSignDefaultSince: now.AddHours(-1)) };
        var accounts = new MemoryAccounts { Vault = new(1, [account], account.Id) };
        var clock = new FakeClock(now);
        var school = new FakeSchool { Now = now, Sign = () => Task.FromResult(new SignResult(SignOutcome.Unknown, "未签到")) };
        var data = new MemoryData();
        var model = new AccountCoordinator(school, accounts, data, data, new FakeReminders(), clock,
            fixedAutoSignPolicy: AutoSignPolicy.BeforeClass) { IsForeground = true };
        await model.InitializeAsync();
        return (model, clock, school, data);
    }

    static void SetTime((AccountCoordinator Model, FakeClock Clock, FakeSchool School, MemoryData Data) h, int minutesBefore)
        => h.Clock.Now = h.School.Now = TestData.Now.AddMinutes(-minutesBefore);

    [Fact]
    public async Task FirstCheckStartsTwentyNineMinutesBeforeClass()
    {
        var h = await Setup();
        var plan = Assert.Single(h.Model.AutoSignPlans);
        Assert.Equal(TestData.Now.AddMinutes(-29), plan.PlannedAt);
        Assert.Equal(TestData.Now, plan.Deadline);
        Assert.Equal(3, plan.Policy.RetryMinutes);
        SetTime(h, 30);
        await h.Model.TickAsync();
        Assert.Equal(0, h.School.Signs);
        var reads = h.School.Reads;
        SetTime(h, 29);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
        Assert.True(h.School.Reads >= reads + 2); // Before submitting and after the response.
    }

    [Fact]
    public async Task FailedAttemptsRetryEveryThreeMinutesThroughTheWholeWindow()
    {
        var h = await Setup();
        for (var attempt = 0; attempt < 10; attempt++)
        {
            SetTime(h, 29 - attempt * 3);
            await h.Model.TickAsync();
            Assert.Equal(attempt + 1, h.School.Signs);
            h.Clock.Now = h.School.Now = attempt < 9
                ? h.Clock.Now.AddMinutes(2).AddSeconds(59) : TestData.Now.AddSeconds(-1);
            await h.Model.TickAsync();
            Assert.Equal(attempt + 1, h.School.Signs);
        }
        SetTime(h, 0);
        await h.Model.TickAsync();
        Assert.Equal(10, h.School.Signs);
        Assert.Null(Assert.Single(h.Model.AutoSignPlans).NextAt);
        SetTime(h, -3);
        var reads = h.School.Reads;
        await h.Model.TickAsync();
        Assert.Equal(10, h.School.Signs);
        Assert.Equal(reads, h.School.Reads);
        Assert.Single(h.Data.AutoSign.Values).Validate("a");
    }

    [Fact]
    public async Task VerifiedSuccessStopsFutureSubmissions()
    {
        var h = await Setup();
        var signed = false;
        h.School.Query = (_, _) => Task.FromResult(new CourseQueryResult([TestData.Course() with { Signed = signed }], ""));
        h.School.Sign = () => { signed = true; return Task.FromResult(new SignResult(SignOutcome.Signed, "已签到")); };
        SetTime(h, 29);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
        Assert.Equal(AutoSignStage.Signed, Assert.Single(h.Model.AutoSignHistory).Stage);
        SetTime(h, 26);
        await h.Model.TickAsync();
        SetTime(h, 0);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
    }

    [Fact]
    public async Task SchoolSuccessBeforeRetryPreventsAnotherSubmission()
    {
        var h = await Setup();
        SetTime(h, 29);
        await h.Model.TickAsync();
        h.School.Query = (_, _) => Task.FromResult(new CourseQueryResult([TestData.Course() with { Signed = true }], ""));
        SetTime(h, 26);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
        Assert.Equal(AutoSignStage.Signed, Assert.Single(h.Model.AutoSignHistory).Stage);
    }

    [Fact]
    public async Task EnablingDuringTheWindowChecksImmediatelyAndTurningOffStopsRetries()
    {
        var h = await Setup(20, enabled: false);
        await h.Model.SetPreferencesAsync(true, false);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
        await h.Model.SetPreferencesAsync(false, false);
        SetTime(h, 17);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
    }

    [Fact]
    public async Task EnablingAfterClassStartsDoesNotSubmit()
    {
        var h = await Setup(-1, enabled: false);
        await h.Model.SetPreferencesAsync(true, false);
        await h.Model.TickAsync();
        Assert.Equal(0, h.School.Signs);
    }

    [Fact]
    public async Task DeadlineIsCheckedAgainBeforeTheRequestIsSent()
    {
        var h = await Setup();
        h.School.BeforeSignAuthorization = () => { h.School.Now = TestData.Now; return Task.CompletedTask; };
        SetTime(h, 29);
        await h.Model.TickAsync();
        Assert.Equal(0, h.School.Signs);
    }

    [Fact]
    public async Task FailedSchoolQueriesWaitThreeMinutesBeforeTryingAgain()
    {
        var h = await Setup();
        h.School.Query = (_, _) => throw new IOException("连接失败");
        SetTime(h, 29);
        await h.Model.TickAsync();
        var reads = h.School.Reads;
        SetTime(h, 28);
        await h.Model.TickAsync();
        Assert.Equal(reads, h.School.Reads);
        Assert.Equal(0, h.School.Signs);
        h.School.Query = (_, _) => Task.FromResult(new CourseQueryResult([TestData.Course()], ""));
        SetTime(h, 26);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
    }

    [Fact]
    public async Task OutsideWindowResponseCanBeRetriedBeforeClassStarts()
    {
        var h = await Setup();
        h.School.Sign = () => Task.FromResult(new SignResult(SignOutcome.OutsideSignWindow, "尚未开放"));
        SetTime(h, 29);
        await h.Model.TickAsync();
        Assert.Equal(1, h.School.Signs);
        SetTime(h, 26);
        await h.Model.TickAsync();
        Assert.Equal(2, h.School.Signs);
    }

    [Fact]
    public async Task AlreadySignedSchoolStatusSkipsSubmission()
    {
        var h = await Setup();
        h.School.Query = (_, _) => Task.FromResult(new CourseQueryResult([TestData.Course() with { Signed = true }], ""));
        SetTime(h, 29);
        await h.Model.TickAsync();
        Assert.Equal(0, h.School.Signs);
        Assert.Equal(AutoSignStage.Signed, Assert.Single(h.Model.AutoSignHistory).Stage);
    }

    [Fact]
    public async Task RestartKeepsTheSubmissionCountAndThreeMinuteRetryTime()
    {
        var h = await Setup();
        SetTime(h, 29);
        await h.Model.TickAsync();
        SetTime(h, 26);
        await h.Model.TickAsync();
        Assert.Equal(2, h.School.Signs);
        var accounts = new MemoryAccounts { Vault = new(1, [h.Model.ActiveAccount!], "a") };
        var restarted = new AccountCoordinator(h.School, accounts, h.Data, h.Data, new FakeReminders(), h.Clock,
            fixedAutoSignPolicy: AutoSignPolicy.BeforeClass) { IsForeground = true };
        await restarted.InitializeAsync();
        SetTime(h, 24);
        await restarted.TickAsync();
        Assert.Equal(2, h.School.Signs);
        SetTime(h, 23);
        await restarted.TickAsync();
        Assert.Equal(3, h.School.Signs);
        Assert.Equal(3, Assert.Single(restarted.AutoSignHistory).Submissions);
    }
}
