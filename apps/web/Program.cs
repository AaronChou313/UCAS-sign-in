using System.IO.Compression;
using System.Net;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using QRCoder;
using UCASSignIn.Core;
using UCASSignIn.Web;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(17861));
var dataRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("UCAS_WEB_DATA")
    ?? Path.Combine(builder.Environment.ContentRootPath, "../../.local/web"));
Directory.CreateDirectory(dataRoot);
if (!OperatingSystem.IsWindows())
    File.SetUnixFileMode(dataRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
builder.Services.AddDataProtection().SetApplicationName("UCASSignIn.Web")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataRoot, "keys")));
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton<ISchoolClient, SchoolClient>();
builder.Services.AddSingleton<IAccountStore>(sp => new WebAccountStore(Path.Combine(dataRoot, "accounts.bin"),
    sp.GetRequiredService<IDataProtectionProvider>()));
builder.Services.AddSingleton(new FileDataStore(dataRoot));
builder.Services.AddSingleton<WebReminders>();
builder.Services.AddSingleton(sp => new AccountCoordinator(sp.GetRequiredService<ISchoolClient>(),
    sp.GetRequiredService<IAccountStore>(), sp.GetRequiredService<FileDataStore>(),
    sp.GetRequiredService<FileDataStore>(), sp.GetRequiredService<WebReminders>(), fixedAutoSignPolicy: AutoSignPolicy.BeforeClass));
builder.Services.AddSingleton<WebRuntime>();
builder.Services.AddHostedService<SignInWorker>();
var app = builder.Build();
var sourceRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("UCAS_WEB_SOURCE")
    ?? Path.Combine(builder.Environment.ContentRootPath, "../.."));

app.Use(async (context, next) =>
{
    // Allow direct IP access over LAN/mesh networks while rejecting arbitrary DNS hosts.
    var host = context.Request.Host.Host;
    if (!host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
        && !IPAddress.TryParse(host.Trim('[', ']'), out _))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.Headers.CacheControl = "no-store";
        var origin = context.Request.Headers.Origin.ToString();
        if (origin.Length > 0 && origin != $"{context.Request.Scheme}://{context.Request.Host}")
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }
    try { await next(context); }
    catch (SchoolException e) { await Error(context, StatusCodes.Status400BadRequest, e.Message); }
    catch (BadHttpRequestException e) { await Error(context, e.StatusCode, e.Message); }
    catch (ArgumentException e) { await Error(context, StatusCodes.Status400BadRequest, e.Message); }
    catch (Exception e)
    {
        app.Logger.LogError(e, "本地服务操作失败");
        await Error(context, StatusCodes.Status500InternalServerError, "本地服务操作失败，请查看服务日志后重试");
    }
});
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapGet("/LICENSE.txt", () => Results.File(Path.Combine(sourceRoot, "LICENSE"), "text/plain"));
app.MapGet("/source.zip", () =>
{
    using var output = new MemoryStream();
    using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
    {
        var files = new[] { "LICENSE", "README.md", "global.json", "Directory.Build.props", "Directory.Build.targets", "run-web.sh", "scripts/web-service.sh" };
        foreach (var file in files)
            archive.CreateEntryFromFile(Path.Combine(sourceRoot, file), file);
        foreach (var directory in new[] { "apps/web", "packages/dotnet/UCASSignIn.Core", "shared/dotnet", "eng" })
        {
            foreach (var file in Directory.EnumerateFiles(Path.Combine(sourceRoot, directory), "*", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(sourceRoot, file).Replace('\\', '/');
                if (relative.Split('/').Any(part => part is "bin" or "obj")) continue;
                archive.CreateEntryFromFile(file, relative);
            }
        }
    }
    return Results.File(output.ToArray(), "application/zip", "UCAS-Sign-In-Web-source.zip");
});
app.MapGet("/api/health", () => new { status = "ok", service = "UCAS-Sign-In Web" });
app.MapGet("/api/state", (WebRuntime runtime) => runtime.StateAsync());
app.MapPost("/api/login", (LoginInput input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.LoginAsync(input.Username, input.Password, input.Remember)));
app.MapPost("/api/demo", (HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.EnterDemoAsync()));
app.MapPost("/api/demo/exit", (HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.ExitDemoAsync()));
app.MapPost("/api/accounts/{id}/switch", (string id, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c =>
    {
        if (!c.Accounts.Any(a => a.Id == id)) throw new BadHttpRequestException("账户不存在", 404);
        return c.SwitchAsync(id);
    }));
app.MapDelete("/api/accounts/{id}", (string id, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.RemoveAsync(id)));
app.MapPost("/api/date", (DateInput input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), async c =>
    {
        c.ScheduleMode = input.Week ? ScheduleMode.Week : ScheduleMode.Day;
        if (input.Date == CourseTime.Today())
        {
            if (!c.CanReturnToToday) throw new BadHttpRequestException("学校提供的学期范围中没有今天");
            await c.ReturnToScheduleTodayAsync();
        }
        else
        {
            if (!c.CanSelectVisibleDate(input.Date)) throw new BadHttpRequestException("请选择当前学期内的日期");
            await c.SelectDateAsync(input.Date);
        }
        if (input.Week) await c.EnterScheduleAsync();
        else await c.EnterDayAsync(input.Date);
    }));
app.MapPost("/api/semester", (SemesterInput input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.SelectScheduleSemesterAsync(input.Id, c.Generation)));
app.MapPost("/api/refresh", (HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.ScheduleMode == ScheduleMode.Week
        ? c.RefreshScheduleAsync() : c.RefreshAsync()));
app.MapPost("/api/catalog", (RefreshInput input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.RefreshCatalogAsync(input.Force)));
app.MapGet("/api/attendance/{id}", (string id, HttpRequest request, WebRuntime runtime) =>
    runtime.RunAsync(async c =>
    {
        await c.RefreshAttendanceAsync(id, request.Query["force"] == "true");
        var summary = c.AttendanceFor(id);
        return new
        {
            summary = summary is null ? null : summary with
            {
                Records = summary.Records.Select(r => r with { Day = WebRuntime.DisplayDay(r.Day) }).ToArray()
            },
            error = c.AttendanceError(id), updatedAt = c.AttendanceUpdatedAt(id)
        };
    }, Generation(request)));
app.MapPost("/api/sign", (CourseInput input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), async c =>
    {
        var course = WebRuntime.FindCourse(c, input.Id, input.Day);
        if (!c.CanSign(course)) throw new BadHttpRequestException("当前课次无法签到，请先刷新学校状态", 409);
        await c.SignAsync(course, c.Generation);
    }));
app.MapGet("/api/qr", (string id, string day, HttpRequest request, WebRuntime runtime) =>
    runtime.RunAsync(async c =>
    {
        var snapshot = await c.QrAsync(WebRuntime.FindCourse(c, id, day), request.HttpContext.RequestAborted);
        using var data = QRCodeGenerator.GenerateQrCode(snapshot.Url, QRCodeGenerator.ECCLevel.M);
        using var qr = new PngByteQRCode(data);
        return new { image = "data:image/png;base64," + Convert.ToBase64String(qr.GetGraphic(8)),
            snapshot.ExpiresAt, snapshot.ValidityDuration, c.IsDemo };
    }, Generation(request)));
app.MapPut("/api/preferences", (PreferencesInput input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.SetPreferencesAsync(input.AutoSign, input.Reminders,
        input.ConfirmBeforeSign, input.ReminderLeadMinutes)));
app.MapPut("/api/courses/{id}/preferences", (string id, CoursePreferences input, HttpRequest request, WebRuntime runtime) =>
    runtime.ChangeAsync(Generation(request), c => c.SetCoursePreferencesAsync(id, input)));

await app.Services.GetRequiredService<WebRuntime>().RunAsync(async c => { await c.InitializeAsync(); return true; });
await app.RunAsync();

static Guid Generation(HttpRequest request) => Guid.TryParse(request.Headers["X-UCAS-Generation"], out var id)
    ? id : throw new BadHttpRequestException("请先刷新页面", StatusCodes.Status409Conflict);
static async Task Error(HttpContext context, int status, string message)
{
    if (context.Response.HasStarted) return;
    context.Response.StatusCode = status;
    await context.Response.WriteAsJsonAsync(new { error = message });
}
record LoginInput(string Username, string Password, bool Remember);
record DateInput(DateOnly Date, bool Week);
record SemesterInput(string Id);
record RefreshInput(bool Force = false);
record CourseInput(string Id, string Day);
record PreferencesInput(bool AutoSign, bool Reminders, bool ConfirmBeforeSign, int ReminderLeadMinutes);
