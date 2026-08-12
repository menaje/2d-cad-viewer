use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::duration_ms;
pub const ADAPTER_PROTOCOL: &str = "dwg-engine-adapter/1";
pub const DEFAULT_MEASURED_RUNS: usize = 3;
pub const DEFAULT_WARMUP_RUNS: usize = 1;

const CACHE_MAGIC: [u8; 8] = *b"DWGSCN1\0";
const CACHE_VERSION_MAJOR: u16 = 1;
const CACHE_VERSION_MINOR: u16 = 25;
const CACHE_HEADER_SIZE: usize = 64;
const CACHE_DIRECTORY_ENTRY_SIZE: usize = 40;
const CACHE_SECTION_COUNT: usize = 51;
const MAX_MEASURED_RUNS: usize = 20;
const MAX_WARMUP_RUNS: usize = 10;
const MAX_IDENTITY_BYTES: usize = 128;
const MAX_ADAPTER_STDOUT_BYTES: usize = 16 * 1024 * 1024;
const CONVERSION_TARGET_MS: u64 = 5_000;
const CONVERSION_HARD_LIMIT_MS: u64 = 8_000;
const PEAK_RSS_TARGET_BYTES: u64 = 600_000_000;
const PEAK_RSS_HARD_LIMIT_BYTES: u64 = 800_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BenchmarkScope {
    Inspect,
    Convert,
    All,
}

impl BenchmarkScope {
    fn includes(self, phase: BenchmarkPhase) -> bool {
        matches!(
            (self, phase),
            (Self::Inspect, BenchmarkPhase::Inspect)
                | (Self::Convert, BenchmarkPhase::Convert)
                | (Self::All, _)
        )
    }
}

#[derive(Debug, Clone)]
pub struct BenchmarkOptions {
    pub adapter_executable: PathBuf,
    pub engine_id: String,
    pub engine_version: Option<String>,
    pub engine_license: Option<String>,
    pub measured_runs: usize,
    pub warmup_runs: usize,
    pub scope: BenchmarkScope,
    pub include_input_name: bool,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkReport {
    pub schema: &'static str,
    pub status: &'static str,
    pub engine: BenchmarkEngine,
    pub input: BenchmarkInput,
    pub environment: BenchmarkEnvironment,
    pub config: BenchmarkConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspection: Option<BenchmarkPhaseSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversion: Option<BenchmarkPhaseSummary>,
    pub decision: BenchmarkDecision,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkEngine {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub adapter: AdapterKind,
    pub protocol: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterKind {
    External,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkEnvironment {
    pub runner_version: &'static str,
    pub runner_profile: &'static str,
    pub operating_system: &'static str,
    pub architecture: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_cpus: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkConfig {
    pub measured_runs: usize,
    pub warmup_runs: usize,
    pub scope: BenchmarkScope,
    pub process_isolated: bool,
    pub file_cache_control: &'static str,
    pub conversion_cache_retained: bool,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkPhaseSummary {
    pub runs: Vec<BenchmarkRun>,
    pub wall_ms: MetricSummary,
    pub reported_total_ms: MetricSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_rss_bytes: Option<MetricSummary>,
    pub deterministic_output: bool,
    pub fingerprint: Value,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkRun {
    pub iteration: usize,
    pub wall_ms: u64,
    pub parse_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_ms: Option<u64>,
    pub reported_total_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_rss_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MetricSummary {
    pub samples: usize,
    pub minimum: u64,
    pub median: u64,
    pub maximum: u64,
}

#[derive(Debug, Serialize)]
pub struct BenchmarkDecision {
    pub status: BenchmarkStatus,
    pub deterministic_output: bool,
    pub conversion_wall_ms: GateDecision,
    pub peak_rss_bytes: GateDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BenchmarkStatus {
    Pass,
    TargetMiss,
    HardFail,
    Incomplete,
}

#[derive(Debug, Serialize)]
pub struct GateDecision {
    pub target: u64,
    pub hard_limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<MetricSummary>,
    pub status: GateStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pass,
    TargetMiss,
    HardFail,
    Unavailable,
}

#[derive(Debug, Clone, Copy)]
enum BenchmarkPhase {
    Inspect,
    Convert,
}

impl BenchmarkPhase {
    fn command_name(self) -> &'static str {
        match self {
            Self::Inspect => "inspect",
            Self::Convert => "convert",
        }
    }

    fn expected_schema(self) -> &'static str {
        match self {
            Self::Inspect => "dwg-inspection/1",
            Self::Convert => "dwg-scene-cache/1",
        }
    }
}

#[derive(Debug)]
struct Adapter {
    executable: PathBuf,
    kind: AdapterKind,
}

#[derive(Debug)]
struct AdapterObservation {
    run: BenchmarkRun,
    fingerprint: Value,
}

#[derive(Debug)]
struct BenchmarkWorkspace {
    path: PathBuf,
}

impl BenchmarkWorkspace {
    fn create() -> Result<Self> {
        let base = std::env::temp_dir();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for attempt in 0_u32..100 {
            let path = base.join(format!(
                "dwg-viewer-benchmark-{}-{timestamp}-{attempt}",
                std::process::id()
            ));
            match create_private_directory(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error).with_context(|| "cannot create private benchmark workspace")
                }
            }
        }
        anyhow::bail!("cannot allocate a unique private benchmark workspace");
    }

    fn cache_path(&self, ordinal: usize) -> PathBuf {
        self.path.join(format!("run-{ordinal}.cache"))
    }
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)
}

impl Drop for BenchmarkWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn benchmark_engine(input: &Path, options: &BenchmarkOptions) -> Result<BenchmarkReport> {
    validate_options(options)?;
    let metadata = fs::metadata(input)
        .with_context(|| format!("cannot read input metadata: {}", input.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("input is not a file: {}", input.display());
    }

    let adapter = resolve_adapter(options)?;
    let workspace = BenchmarkWorkspace::create()?;
    let mut cache_ordinal = 0_usize;

    let inspection = if options.scope.includes(BenchmarkPhase::Inspect) {
        for _ in 0..options.warmup_runs {
            run_adapter(
                &adapter,
                input,
                metadata.len(),
                BenchmarkPhase::Inspect,
                &workspace,
                &mut cache_ordinal,
                0,
            )?;
        }
        let observations = (1..=options.measured_runs)
            .map(|iteration| {
                run_adapter(
                    &adapter,
                    input,
                    metadata.len(),
                    BenchmarkPhase::Inspect,
                    &workspace,
                    &mut cache_ordinal,
                    iteration,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        Some(summarize_phase(observations)?)
    } else {
        None
    };

    let conversion = if options.scope.includes(BenchmarkPhase::Convert) {
        for _ in 0..options.warmup_runs {
            run_adapter(
                &adapter,
                input,
                metadata.len(),
                BenchmarkPhase::Convert,
                &workspace,
                &mut cache_ordinal,
                0,
            )?;
        }
        let observations = (1..=options.measured_runs)
            .map(|iteration| {
                run_adapter(
                    &adapter,
                    input,
                    metadata.len(),
                    BenchmarkPhase::Convert,
                    &workspace,
                    &mut cache_ordinal,
                    iteration,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        Some(summarize_phase(observations)?)
    } else {
        None
    };

    let decision = evaluate_decision(inspection.as_ref(), conversion.as_ref());
    Ok(BenchmarkReport {
        schema: "dwg-engine-benchmark/1",
        status: "ok",
        engine: BenchmarkEngine {
            id: options.engine_id.clone(),
            version: options.engine_version.clone(),
            license: options.engine_license.clone(),
            adapter: adapter.kind,
            protocol: ADAPTER_PROTOCOL,
        },
        input: BenchmarkInput {
            name: options.include_input_name.then(|| {
                input
                    .file_name()
                    .unwrap_or(input.as_os_str())
                    .to_string_lossy()
                    .into_owned()
            }),
            size_bytes: metadata.len(),
        },
        environment: BenchmarkEnvironment {
            runner_version: env!("CARGO_PKG_VERSION"),
            runner_profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            logical_cpus: std::thread::available_parallelism().ok().map(usize::from),
        },
        config: BenchmarkConfig {
            measured_runs: options.measured_runs,
            warmup_runs: options.warmup_runs,
            scope: options.scope,
            process_isolated: true,
            file_cache_control: "operating_system_default",
            conversion_cache_retained: false,
        },
        inspection,
        conversion,
        decision,
    })
}

fn validate_options(options: &BenchmarkOptions) -> Result<()> {
    if !(1..=MAX_MEASURED_RUNS).contains(&options.measured_runs) {
        anyhow::bail!("measured runs must be between 1 and {MAX_MEASURED_RUNS}, inclusive");
    }
    if options.warmup_runs > MAX_WARMUP_RUNS {
        anyhow::bail!("warmup runs must not exceed {MAX_WARMUP_RUNS}");
    }
    validate_identity("engine id", &options.engine_id, true)?;
    if let Some(version) = &options.engine_version {
        validate_identity("engine version", version, false)?;
    }
    if let Some(license) = &options.engine_license {
        validate_identity("engine license", license, false)?;
    }
    Ok(())
}

fn validate_identity(label: &str, value: &str, restricted: bool) -> Result<()> {
    if value.is_empty() || value.len() > MAX_IDENTITY_BYTES {
        anyhow::bail!("{label} must contain between 1 and {MAX_IDENTITY_BYTES} bytes");
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("{label} must not contain control characters");
    }
    if restricted
        && !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        anyhow::bail!("{label} may contain only ASCII letters, digits, '.', '_' and '-'");
    }
    Ok(())
}

fn resolve_adapter(options: &BenchmarkOptions) -> Result<Adapter> {
    let executable = options.adapter_executable.clone();
    let metadata = fs::metadata(&executable)
        .with_context(|| format!("cannot read adapter metadata: {}", executable.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("adapter is not a file: {}", executable.display());
    }
    Ok(Adapter {
        executable,
        kind: AdapterKind::External,
    })
}

#[allow(clippy::too_many_arguments)]
fn run_adapter(
    adapter: &Adapter,
    input: &Path,
    input_size: u64,
    phase: BenchmarkPhase,
    workspace: &BenchmarkWorkspace,
    cache_ordinal: &mut usize,
    iteration: usize,
) -> Result<AdapterObservation> {
    let mut command = Command::new(&adapter.executable);
    command
        .arg(phase.command_name())
        .arg(input)
        .env("DWG_VIEWER_ADAPTER_PROTOCOL", ADAPTER_PROTOCOL)
        .env("DWG_VIEWER_BENCHMARK_PHASE", phase.command_name())
        .stdin(Stdio::null())
        .stderr(Stdio::null());

    let cache_path = if matches!(phase, BenchmarkPhase::Convert) {
        let path = workspace.cache_path(*cache_ordinal);
        *cache_ordinal = cache_ordinal
            .checked_add(1)
            .context("benchmark cache ordinal overflow")?;
        command.arg(&path);
        Some(path)
    } else {
        command.args(["--notification-samples", "0"]);
        None
    };

    let started = Instant::now();
    let output = command
        .output()
        .with_context(|| format!("cannot start {} adapter phase", phase.command_name()))?;
    let wall_ms = duration_ms(started.elapsed());

    if !output.status.success() {
        if let Some(path) = &cache_path {
            let _ = fs::remove_file(path);
        }
        anyhow::bail!(
            "{} adapter phase failed with {}",
            phase.command_name(),
            output.status
        );
    }
    if output.stdout.len() > MAX_ADAPTER_STDOUT_BYTES {
        anyhow::bail!(
            "{} adapter report exceeds the {} byte limit",
            phase.command_name(),
            MAX_ADAPTER_STDOUT_BYTES
        );
    }

    let cache_size = if let Some(path) = &cache_path {
        let cache_metadata = fs::metadata(path).with_context(|| {
            format!(
                "{} adapter did not create its requested cache",
                phase.command_name()
            )
        })?;
        if !cache_metadata.is_file() {
            anyhow::bail!("convert adapter output is not a regular cache file");
        }
        validate_scene_cache_v125(path, input_size)
            .context("convert adapter created an invalid Scene Cache v1.25")?;
        Some(cache_metadata.len())
    } else {
        None
    };

    let report: Value = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("{} adapter emitted invalid JSON", phase.command_name()))?;
    let observation = parse_observation(report, phase, input_size, cache_size, iteration, wall_ms)?;

    if let Some(path) = &cache_path {
        fs::remove_file(path).context("cannot remove temporary benchmark cache")?;
    }
    Ok(observation)
}

fn parse_observation(
    report: Value,
    phase: BenchmarkPhase,
    input_size: u64,
    cache_size: Option<u64>,
    iteration: usize,
    wall_ms: u64,
) -> Result<AdapterObservation> {
    let object = report
        .as_object()
        .context("adapter report root must be a JSON object")?;
    require_string(object.get("schema"), "schema", phase.expected_schema())?;
    require_string(object.get("status"), "status", "ok")?;
    for required in match phase {
        BenchmarkPhase::Inspect => [
            "input",
            "drawing",
            "performance",
            "entity_types",
            "unknown_entities",
            "text",
            "bounds",
            "diagnostics",
        ]
        .as_slice(),
        BenchmarkPhase::Convert => [
            "input",
            "cache",
            "coverage",
            "gpu_lines",
            "hatch_fills",
            "performance",
            "diagnostics",
        ]
        .as_slice(),
    } {
        if !object.contains_key(*required) {
            anyhow::bail!("adapter report is missing required field '{required}'");
        }
    }

    let reported_input_size = report
        .pointer("/input/size_bytes")
        .and_then(Value::as_u64)
        .context("adapter report input.size_bytes must be a u64")?;
    if reported_input_size != input_size {
        anyhow::bail!(
            "adapter input size mismatch: expected {input_size}, reported {reported_input_size}"
        );
    }
    if let Some(cache_size) = cache_size {
        let reported_cache_size = report
            .pointer("/cache/size_bytes")
            .and_then(Value::as_u64)
            .context("adapter report cache.size_bytes must be a u64")?;
        if reported_cache_size != cache_size {
            anyhow::bail!(
                "adapter cache size mismatch: actual {cache_size}, reported {reported_cache_size}"
            );
        }
        if report.pointer("/cache/validated").and_then(Value::as_bool) != Some(true) {
            anyhow::bail!("adapter report cache.validated must be true");
        }
        if report
            .pointer("/cache/format_major")
            .and_then(Value::as_u64)
            != Some(u64::from(CACHE_VERSION_MAJOR))
            || report
                .pointer("/cache/format_minor")
                .and_then(Value::as_u64)
                != Some(u64::from(CACHE_VERSION_MINOR))
        {
            anyhow::bail!("adapter report must identify Scene Cache v1.25");
        }
    }

    let performance = report
        .get("performance")
        .and_then(Value::as_object)
        .context("adapter performance must be a JSON object")?;
    let parse_ms = required_u64(performance.get("parse_ms"), "performance.parse_ms")?;
    let reported_total_ms = required_u64(performance.get("total_ms"), "performance.total_ms")?;
    let analysis_ms = optional_u64(performance.get("analysis_ms"), "performance.analysis_ms")?;
    let write_ms = optional_u64(performance.get("write_ms"), "performance.write_ms")?;
    let peak_rss_bytes = optional_u64(
        performance.get("peak_rss_bytes"),
        "performance.peak_rss_bytes",
    )?;

    Ok(AdapterObservation {
        run: BenchmarkRun {
            iteration,
            wall_ms,
            parse_ms,
            analysis_ms,
            write_ms,
            reported_total_ms,
            peak_rss_bytes,
        },
        fingerprint: fingerprint(report, phase)?,
    })
}

fn require_string(value: Option<&Value>, field: &str, expected: &str) -> Result<()> {
    let actual = value
        .and_then(Value::as_str)
        .with_context(|| format!("adapter report {field} must be a string"))?;
    if actual != expected {
        anyhow::bail!("adapter report {field} must be '{expected}', got '{actual}'");
    }
    Ok(())
}

fn required_u64(value: Option<&Value>, field: &str) -> Result<u64> {
    value
        .and_then(Value::as_u64)
        .with_context(|| format!("adapter report {field} must be a u64"))
}

fn optional_u64(value: Option<&Value>, field: &str) -> Result<Option<u64>> {
    match value {
        Some(Value::Null) | None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .with_context(|| format!("adapter report {field} must be a u64 or null")),
    }
}

fn fingerprint(mut report: Value, phase: BenchmarkPhase) -> Result<Value> {
    let object = report
        .as_object_mut()
        .context("adapter report root must be a JSON object")?;
    object.remove("schema");
    object.remove("status");
    object.remove("performance");
    if let Some(input) = object.get_mut("input").and_then(Value::as_object_mut) {
        input.remove("name");
    }
    if matches!(phase, BenchmarkPhase::Inspect) {
        if let Some(bounds) = object.remove("bounds") {
            object.insert("bounds_present".to_owned(), Value::Bool(!bounds.is_null()));
        }
        if let Some(samples) = object.get_mut("text").and_then(Value::as_object_mut) {
            samples.remove("samples");
        }
        if let Some(diagnostics) = object.get_mut("diagnostics").and_then(Value::as_object_mut) {
            diagnostics.remove("samples");
        }
        if let Some(largest_block) = object
            .get_mut("drawing")
            .and_then(Value::as_object_mut)
            .and_then(|drawing| drawing.get_mut("largest_block"))
            .and_then(Value::as_object_mut)
        {
            largest_block.remove("name");
        }
    }
    Ok(report)
}

fn summarize_phase(observations: Vec<AdapterObservation>) -> Result<BenchmarkPhaseSummary> {
    let first = observations
        .first()
        .context("cannot summarize an empty benchmark phase")?;
    let fingerprint = first.fingerprint.clone();
    let deterministic_output = observations
        .iter()
        .all(|observation| observation.fingerprint == fingerprint);
    let wall_ms = summarize_metric(observations.iter().map(|value| value.run.wall_ms))?;
    let reported_total_ms =
        summarize_metric(observations.iter().map(|value| value.run.reported_total_ms))?;
    let peak_values = observations
        .iter()
        .map(|value| value.run.peak_rss_bytes)
        .collect::<Option<Vec<_>>>();
    let peak_rss_bytes = peak_values.map(summarize_metric).transpose()?;

    Ok(BenchmarkPhaseSummary {
        runs: observations.into_iter().map(|value| value.run).collect(),
        wall_ms,
        reported_total_ms,
        peak_rss_bytes,
        deterministic_output,
        fingerprint,
    })
}

fn summarize_metric(values: impl IntoIterator<Item = u64>) -> Result<MetricSummary> {
    let mut values: Vec<_> = values.into_iter().collect();
    if values.is_empty() {
        anyhow::bail!("cannot summarize an empty metric");
    }
    values.sort_unstable();
    let median = if values.len() % 2 == 1 {
        values[values.len() / 2]
    } else {
        let left = values[values.len() / 2 - 1];
        let right = values[values.len() / 2];
        left + (right - left) / 2
    };
    Ok(MetricSummary {
        samples: values.len(),
        minimum: values[0],
        median,
        maximum: values[values.len() - 1],
    })
}

fn evaluate_decision(
    inspection: Option<&BenchmarkPhaseSummary>,
    conversion: Option<&BenchmarkPhaseSummary>,
) -> BenchmarkDecision {
    let deterministic_output = inspection
        .map(|phase| phase.deterministic_output)
        .unwrap_or(true)
        && conversion
            .map(|phase| phase.deterministic_output)
            .unwrap_or(true);
    let conversion_wall_ms = evaluate_gate(
        conversion.map(|phase| phase.wall_ms.clone()),
        CONVERSION_TARGET_MS,
        CONVERSION_HARD_LIMIT_MS,
    );
    // Parsing is a mandatory subset of conversion. A parser-only candidate
    // that already exceeds the hard memory limit cannot be rescued by adding
    // a cache writer, so allow the inspection phase to reject it before that
    // additional implementation work. Prefer the full conversion observation
    // whenever it exists.
    let peak_observation = match conversion {
        Some(phase) => phase.peak_rss_bytes.clone(),
        None => inspection.and_then(|phase| phase.peak_rss_bytes.clone()),
    };
    let peak_rss_bytes = evaluate_gate(
        peak_observation,
        PEAK_RSS_TARGET_BYTES,
        PEAK_RSS_HARD_LIMIT_BYTES,
    );

    let statuses = [conversion_wall_ms.status, peak_rss_bytes.status];
    let status = if !deterministic_output || statuses.contains(&GateStatus::HardFail) {
        BenchmarkStatus::HardFail
    } else if statuses.contains(&GateStatus::Unavailable) {
        BenchmarkStatus::Incomplete
    } else if statuses.contains(&GateStatus::TargetMiss) {
        BenchmarkStatus::TargetMiss
    } else {
        BenchmarkStatus::Pass
    };
    BenchmarkDecision {
        status,
        deterministic_output,
        conversion_wall_ms,
        peak_rss_bytes,
    }
}

fn evaluate_gate(observed: Option<MetricSummary>, target: u64, hard_limit: u64) -> GateDecision {
    let status = match &observed {
        Some(metric) if metric.maximum > hard_limit => GateStatus::HardFail,
        Some(metric) if metric.median > target => GateStatus::TargetMiss,
        Some(_) => GateStatus::Pass,
        None => GateStatus::Unavailable,
    };
    GateDecision {
        target,
        hard_limit,
        observed,
        status,
    }
}

fn validate_scene_cache_v125(path: &Path, expected_source_size: u64) -> Result<()> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("cannot read cache metadata: {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("cache is not a regular file");
    }

    let mut file =
        File::open(path).with_context(|| format!("cannot open cache: {}", path.display()))?;
    let mut header = [0_u8; CACHE_HEADER_SIZE];
    file.read_exact(&mut header)
        .context("cannot read Scene Cache header")?;
    if header[..CACHE_MAGIC.len()] != CACHE_MAGIC {
        anyhow::bail!("invalid Scene Cache magic");
    }
    let major = read_u16(&header, 8);
    let minor = read_u16(&header, 10);
    if major != CACHE_VERSION_MAJOR || minor != CACHE_VERSION_MINOR {
        anyhow::bail!(
            "unsupported Scene Cache version {major}.{minor}; expected \
             {CACHE_VERSION_MAJOR}.{CACHE_VERSION_MINOR}"
        );
    }
    if read_u32(&header, 12) != CACHE_HEADER_SIZE as u32 {
        anyhow::bail!("unexpected Scene Cache header size");
    }
    let section_count = usize::try_from(read_u32(&header, 16))
        .context("Scene Cache section count exceeds usize")?;
    if section_count != CACHE_SECTION_COUNT {
        anyhow::bail!(
            "Scene Cache v1.25 must contain {CACHE_SECTION_COUNT} sections, found {section_count}"
        );
    }
    if read_u32(&header, 20) != CACHE_DIRECTORY_ENTRY_SIZE as u32 {
        anyhow::bail!("unexpected Scene Cache directory-entry size");
    }
    if read_u32(&header, 24) != 0 || read_u32(&header, 28) != 0 {
        anyhow::bail!("benchmark conversion cache must be canonical");
    }

    let directory_offset = read_u64(&header, 32);
    let recorded_file_size = read_u64(&header, 40);
    let recorded_source_size = read_u64(&header, 48);
    if recorded_file_size != metadata.len() {
        anyhow::bail!(
            "Scene Cache size mismatch: header={recorded_file_size}, file={}",
            metadata.len()
        );
    }
    if recorded_source_size != expected_source_size {
        anyhow::bail!(
            "Scene Cache source size mismatch: expected {expected_source_size}, recorded {recorded_source_size}"
        );
    }

    let directory_length = (section_count as u64)
        .checked_mul(CACHE_DIRECTORY_ENTRY_SIZE as u64)
        .context("Scene Cache directory length overflow")?;
    let directory_end = directory_offset
        .checked_add(directory_length)
        .context("Scene Cache directory end overflow")?;
    if directory_offset < CACHE_HEADER_SIZE as u64 || directory_end > recorded_file_size {
        anyhow::bail!("Scene Cache directory is outside the file");
    }
    let body_start = align_up_8(directory_end).context("Scene Cache body offset overflow")?;

    let mut directory = vec![0_u8; usize::try_from(directory_length)?];
    file.seek(SeekFrom::Start(directory_offset))
        .context("cannot seek to Scene Cache directory")?;
    file.read_exact(&mut directory)
        .context("cannot read Scene Cache directory")?;

    let mut kinds = BTreeSet::new();
    let mut ranges = Vec::with_capacity(section_count);
    for index in 0..section_count {
        let offset = index * CACHE_DIRECTORY_ENTRY_SIZE;
        let entry = &directory[offset..offset + CACHE_DIRECTORY_ENTRY_SIZE];
        let kind = read_u32(entry, 0);
        let record_size = read_u32(entry, 4);
        let section_offset = read_u64(entry, 8);
        let byte_length = read_u64(entry, 16);
        let record_count = read_u64(entry, 24);
        let flags = read_u32(entry, 32);
        let reserved = read_u32(entry, 36);

        if !is_current_section_kind(kind) || !kinds.insert(kind) {
            anyhow::bail!("Scene Cache contains an unexpected or duplicate section {kind}");
        }
        if record_size == 0 || flags & !1 != 0 || reserved != 0 {
            anyhow::bail!("Scene Cache section {kind} has invalid metadata");
        }
        let records_length = u64::from(record_size)
            .checked_mul(record_count)
            .context("Scene Cache record length overflow")?;
        if (flags == 0 && records_length != byte_length)
            || (flags == 1
                && records_length
                    .checked_add(16)
                    .is_none_or(|minimum| byte_length < minimum))
        {
            anyhow::bail!("Scene Cache section {kind} has an invalid byte length");
        }
        let section_end = section_offset
            .checked_add(byte_length)
            .context("Scene Cache section end overflow")?;
        if section_offset < body_start
            || section_offset % 8 != 0
            || section_end > recorded_file_size
        {
            anyhow::bail!("Scene Cache section {kind} has an invalid range");
        }
        ranges.push((section_offset, section_end, kind));
    }

    ranges.sort_unstable_by_key(|range| range.0);
    for pair in ranges.windows(2) {
        if pair[0].1 > pair[1].0 {
            anyhow::bail!(
                "Scene Cache sections {} and {} overlap",
                pair[0].2,
                pair[1].2
            );
        }
    }
    Ok(())
}

fn is_current_section_kind(kind: u32) -> bool {
    matches!(kind, 1..=4 | 10..=23 | 30..=62)
}

fn align_up_8(value: u64) -> Option<u64> {
    value.checked_add(7).map(|value| value & !7)
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("bounded slice"))
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("bounded slice"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("bounded slice"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_summary_uses_a_stable_integer_median() {
        let odd = summarize_metric([9, 1, 5]).unwrap();
        assert_eq!(
            odd,
            MetricSummary {
                samples: 3,
                minimum: 1,
                median: 5,
                maximum: 9,
            }
        );

        let even = summarize_metric([8, 2, 6, 4]).unwrap();
        assert_eq!(even.median, 5);
    }

    #[test]
    fn fingerprint_removes_private_samples_names_and_performance() {
        let first = serde_json::json!({
            "schema": "dwg-inspection/1",
            "status": "ok",
            "input": {"name": "private-a.dwg", "size_bytes": 3},
            "drawing": {
                "largest_block": {"name": "project-a", "entity_handles": 4}
            },
            "performance": {"parse_ms": 1, "total_ms": 2},
            "text": {"entities": 1, "samples": ["비공개"]},
            "bounds": {"min": [1, 2, 3], "max": [4, 5, 6]},
            "diagnostics": {"count": 1, "samples": [{"message": "private"}]}
        });
        let second = serde_json::json!({
            "schema": "dwg-inspection/1",
            "status": "ok",
            "input": {"name": "private-b.dwg", "size_bytes": 3},
            "drawing": {
                "largest_block": {"name": "project-b", "entity_handles": 4}
            },
            "performance": {"parse_ms": 9, "total_ms": 10},
            "text": {"entities": 1, "samples": ["다른 비공개"]},
            "bounds": {"min": [10, 20, 30], "max": [40, 50, 60]},
            "diagnostics": {"count": 1, "samples": [{"message": "other"}]}
        });

        assert_eq!(
            fingerprint(first, BenchmarkPhase::Inspect).unwrap(),
            fingerprint(second, BenchmarkPhase::Inspect).unwrap()
        );
    }

    #[test]
    fn hard_limit_uses_the_maximum_while_target_uses_the_median() {
        let decision = evaluate_gate(
            Some(MetricSummary {
                samples: 3,
                minimum: 4_000,
                median: 4_900,
                maximum: 8_001,
            }),
            5_000,
            8_000,
        );
        assert_eq!(decision.status, GateStatus::HardFail);
    }

    #[test]
    fn parser_memory_can_reject_a_candidate_before_conversion_exists() {
        let inspection = BenchmarkPhaseSummary {
            runs: Vec::new(),
            wall_ms: MetricSummary {
                samples: 3,
                minimum: 1,
                median: 1,
                maximum: 1,
            },
            reported_total_ms: MetricSummary {
                samples: 3,
                minimum: 1,
                median: 1,
                maximum: 1,
            },
            peak_rss_bytes: Some(MetricSummary {
                samples: 3,
                minimum: 1_300_000_000,
                median: 1_310_000_000,
                maximum: 1_320_000_000,
            }),
            deterministic_output: true,
            fingerprint: Value::Null,
        };

        let decision = evaluate_decision(Some(&inspection), None);
        assert_eq!(decision.status, BenchmarkStatus::HardFail);
        assert_eq!(decision.peak_rss_bytes.status, GateStatus::HardFail);
        assert_eq!(decision.conversion_wall_ms.status, GateStatus::Unavailable);

        let conversion_without_rss = BenchmarkPhaseSummary {
            runs: Vec::new(),
            wall_ms: MetricSummary {
                samples: 3,
                minimum: 1,
                median: 1,
                maximum: 1,
            },
            reported_total_ms: MetricSummary {
                samples: 3,
                minimum: 1,
                median: 1,
                maximum: 1,
            },
            peak_rss_bytes: None,
            deterministic_output: true,
            fingerprint: Value::Null,
        };
        let decision = evaluate_decision(Some(&inspection), Some(&conversion_without_rss));
        assert_eq!(decision.status, BenchmarkStatus::Incomplete);
        assert_eq!(decision.peak_rss_bytes.status, GateStatus::Unavailable);
    }

    #[test]
    fn invalid_run_counts_are_rejected() {
        let options = BenchmarkOptions {
            adapter_executable: PathBuf::from("adapter"),
            engine_id: "libredwg".to_owned(),
            engine_version: Some("0.14".to_owned()),
            engine_license: Some("GPL-3.0-or-later".to_owned()),
            measured_runs: 0,
            warmup_runs: 0,
            scope: BenchmarkScope::All,
            include_input_name: false,
        };
        assert!(validate_options(&options).is_err());
    }

    fn write_test_scene_cache(path: &Path, source_size: u64, minor: u16) {
        let directory_offset = CACHE_HEADER_SIZE as u64;
        let directory_length = (CACHE_SECTION_COUNT * CACHE_DIRECTORY_ENTRY_SIZE) as u64;
        let file_size = align_up_8(directory_offset + directory_length).unwrap();
        let mut bytes = vec![0_u8; usize::try_from(file_size).unwrap()];
        bytes[..8].copy_from_slice(&CACHE_MAGIC);
        bytes[8..10].copy_from_slice(&CACHE_VERSION_MAJOR.to_le_bytes());
        bytes[10..12].copy_from_slice(&minor.to_le_bytes());
        bytes[12..16].copy_from_slice(&(CACHE_HEADER_SIZE as u32).to_le_bytes());
        bytes[16..20].copy_from_slice(&(CACHE_SECTION_COUNT as u32).to_le_bytes());
        bytes[20..24].copy_from_slice(&(CACHE_DIRECTORY_ENTRY_SIZE as u32).to_le_bytes());
        bytes[32..40].copy_from_slice(&directory_offset.to_le_bytes());
        bytes[40..48].copy_from_slice(&file_size.to_le_bytes());
        bytes[48..56].copy_from_slice(&source_size.to_le_bytes());

        let kinds = (1_u32..=4)
            .chain(10..=23)
            .chain(30..=62)
            .collect::<Vec<_>>();
        assert_eq!(kinds.len(), CACHE_SECTION_COUNT);
        for (index, kind) in kinds.into_iter().enumerate() {
            let offset = CACHE_HEADER_SIZE + index * CACHE_DIRECTORY_ENTRY_SIZE;
            bytes[offset..offset + 4].copy_from_slice(&kind.to_le_bytes());
            bytes[offset + 4..offset + 8].copy_from_slice(&1_u32.to_le_bytes());
            bytes[offset + 8..offset + 16].copy_from_slice(&file_size.to_le_bytes());
        }
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn structural_validation_accepts_only_scene_cache_v125() {
        let workspace = BenchmarkWorkspace::create().unwrap();
        let current = workspace.path.join("current.cache");
        write_test_scene_cache(&current, 3, CACHE_VERSION_MINOR);
        validate_scene_cache_v125(&current, 3).unwrap();

        let legacy = workspace.path.join("legacy.cache");
        write_test_scene_cache(&legacy, 3, 14);
        assert!(validate_scene_cache_v125(&legacy, 3)
            .unwrap_err()
            .to_string()
            .contains("expected 1.25"));
    }

    #[cfg(unix)]
    #[test]
    fn external_adapter_runs_in_isolated_processes_and_cleans_caches() {
        use std::os::unix::fs::PermissionsExt;

        let fixture_workspace = BenchmarkWorkspace::create().unwrap();
        let input = fixture_workspace.path.join("fixture.dwg");
        fs::write(&input, b"dwg").unwrap();
        let source_cache = fixture_workspace.path.join("fixture.dwg.fixture.cache");
        write_test_scene_cache(&source_cache, 3, CACHE_VERSION_MINOR);
        let adapter = fixture_workspace.path.join("fake-adapter.sh");
        fs::write(
            &adapter,
            r#"#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf '%s\n' '{"schema":"dwg-inspection/1","status":"ok","input":{"size_bytes":3},"drawing":{},"performance":{"parse_ms":1,"analysis_ms":1,"total_ms":2,"peak_rss_bytes":100},"entity_types":{},"unknown_entities":{},"text":{},"bounds":null,"diagnostics":{}}'
  exit 0
fi
if [ "$1" = "convert" ]; then
  cp "$2.fixture.cache" "$3"
  cache_size=$(wc -c < "$3" | tr -d ' ')
  printf '%s\n' '{"schema":"dwg-scene-cache/1","status":"ok","input":{"size_bytes":3},"cache":{"format_major":1,"format_minor":25,"size_bytes":'"$cache_size"',"validated":true},"coverage":{},"gpu_lines":{},"hatch_fills":{},"performance":{"parse_ms":1,"write_ms":2,"total_ms":3,"peak_rss_bytes":100},"diagnostics":0}'
  exit 0
fi
exit 2
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&adapter).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&adapter, permissions).unwrap();

        let report = benchmark_engine(
            &input,
            &BenchmarkOptions {
                adapter_executable: adapter,
                engine_id: "fake".to_owned(),
                engine_version: Some("1".to_owned()),
                engine_license: Some("MIT".to_owned()),
                measured_runs: 2,
                warmup_runs: 1,
                scope: BenchmarkScope::All,
                include_input_name: false,
            },
        )
        .unwrap();

        assert!(report.input.name.is_none());
        assert_eq!(report.engine.id, "fake");
        assert_eq!(report.inspection.unwrap().runs.len(), 2);
        assert_eq!(report.conversion.unwrap().runs.len(), 2);
        assert_eq!(report.decision.status, BenchmarkStatus::Pass);
        assert!(report.decision.deterministic_output);
    }

    #[cfg(unix)]
    #[test]
    fn external_adapter_stderr_is_not_republished() {
        use std::os::unix::fs::PermissionsExt;

        let fixture_workspace = BenchmarkWorkspace::create().unwrap();
        let input = fixture_workspace.path.join("private-name.dwg");
        fs::write(&input, b"dwg").unwrap();
        let adapter = fixture_workspace.path.join("failing-adapter.sh");
        fs::write(
            &adapter,
            "#!/bin/sh\nprintf '%s\\n' 'private drawing diagnostic' >&2\nexit 7\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&adapter).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&adapter, permissions).unwrap();

        let error = benchmark_engine(
            &input,
            &BenchmarkOptions {
                adapter_executable: adapter,
                engine_id: "fake".to_owned(),
                engine_version: None,
                engine_license: None,
                measured_runs: 1,
                warmup_runs: 0,
                scope: BenchmarkScope::Inspect,
                include_input_name: false,
            },
        )
        .unwrap_err()
        .to_string();

        assert!(!error.contains("private drawing diagnostic"));
        assert!(!error.contains("private-name.dwg"));
        assert!(error.contains("exit status: 7"));
    }
}
