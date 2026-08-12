/*
 * SPDX-License-Identifier: MPL-2.0
 */

#ifndef DWG_VIEWER_LIBREDWG_SCENE_CACHE_H
#define DWG_VIEWER_LIBREDWG_SCENE_CACHE_H

#include <dwg.h>

#include <stddef.h>
#include <stdint.h>

#define LIBREDWG_SCENE_CACHE_VERSION_MAJOR 1u
#define LIBREDWG_SCENE_CACHE_VERSION_MINOR 26u
#define LIBREDWG_SCENE_SECTION_COUNT 51

#if LIBREDWG_VERSION >= 14
#define LIBREDWG_MAINTENANCE_VERSION(dwg_ptr) \
  ((dwg_ptr)->header.maint_rel_version)
#else
#define LIBREDWG_MAINTENANCE_VERSION(dwg_ptr) ((dwg_ptr)->header.is_maint)
#endif

typedef struct
{
  uint64_t total_entities;
  uint64_t serialized_entities;
  uint64_t deferred_entities;
  uint64_t lines;
  uint64_t arcs;
  uint64_t circles;
  uint64_t inserts;
  uint64_t dimensions;
  uint64_t lwpolylines;
  uint64_t polylines_2d;
  uint64_t polylines_3d;
  uint64_t polyline_vertices;
  uint64_t ellipses;
  uint64_t splines;
  uint64_t spline_knots;
  uint64_t spline_weights;
  uint64_t spline_control_points;
  uint64_t spline_fit_points;
  uint64_t texts;
  uint64_t mtexts;
  uint64_t attribute_definitions;
  uint64_t attributes;
  uint64_t hatches;
  uint64_t points;
  uint64_t solids;
  uint64_t traces;
  uint64_t regions;
  uint64_t solids_3d;
  uint64_t bodies;
  uint64_t faces;
  uint64_t wipeouts;
  uint64_t images;
  uint64_t xlines;
  uint64_t rays;
  uint64_t mlines;
  uint64_t polyline_meshes;
  uint64_t multileaders;
  uint64_t leaders;
  uint64_t ole2frames;
  uint64_t viewports;
  uint64_t proxy_graphics;
  uint64_t unresolved_dimensions;
  uint64_t unsupported_underlays;
  uint64_t unsupported_proxy_graphics;
  uint64_t unsupported_3d_entities;
  uint64_t invalid_supported_entities;
  uint64_t unsupported_other_entities;
} LibreDwgPrimitiveCounts;

typedef struct
{
  uint64_t model_segments;
  uint64_t block_segments;
  uint64_t overview_segments;
  uint64_t approximated_curve_segments;
  uint64_t hatch_boundary_segments;
  uint64_t truncated_hatch_entities;
  uint64_t skipped_non_finite_segments;
  uint64_t batches;
  uint64_t model_overview_batches;
  uint64_t model_detail_batches;
  uint64_t block_batches;
  uint64_t block_overview_batches;
  uint64_t block_detail_batches;
  uint64_t vertices;
  uint64_t cached_vertex_bytes;
  uint64_t first_frame_vertex_bytes;
  uint64_t full_detail_vertex_bytes;
  uint64_t maximum_batch_bytes;
  double maximum_position_error;
} LibreDwgGpuLineSummary;

typedef struct
{
  uint64_t source_hatches;
  uint64_t solid_hatches;
  uint64_t gradient_hatches;
  uint64_t pattern_hatches;
  uint64_t fill_loops;
  uint64_t fill_vertices;
  uint64_t gradient_colors;
  uint64_t seed_points;
  uint64_t pattern_definition_lines;
  uint64_t pattern_dashes;
  uint64_t truncated_fill_hatches;
  uint64_t truncated_pattern_hatches;
  uint64_t skipped_open_paths;
  uint64_t skipped_invalid_paths;
  uint64_t skipped_invalid_pattern_lines;
} LibreDwgHatchFillSummary;

typedef struct
{
  const char *name;
  uint64_t records;
  uint64_t bytes;
} LibreDwgSectionSummary;

typedef struct
{
  uint64_t reference_resolution_ms;
  uint64_t table_ms;
  uint64_t primitive_count_ms;
  uint64_t gpu_count_ms;
  uint64_t preview_ms;
  uint64_t spatial_index_ms;
  uint64_t spatial_collect_ms;
  uint64_t spatial_sort_ms;
  uint64_t spatial_run_write_ms;
  uint64_t spatial_merge_ms;
  uint64_t section_write_ms;
  uint64_t finalize_ms;
  uint64_t section_group_ms[7];
  uint32_t worker_count;
  uint32_t parallel_sort_workers;
  uint32_t parallel_section_workers;
} LibreDwgSceneCachePerformance;

typedef struct
{
  uint64_t cache_size;
  uint64_t preview_size;
  uint64_t source_linetypes;
  uint64_t serialized_linetypes;
  uint64_t referenced_linetypes;
  uint64_t omitted_referenced_linetypes;
  LibreDwgPrimitiveCounts coverage;
  LibreDwgGpuLineSummary gpu_lines;
  LibreDwgHatchFillSummary hatch_fills;
  LibreDwgSceneCachePerformance performance;
  LibreDwgSectionSummary sections[LIBREDWG_SCENE_SECTION_COUNT];
} LibreDwgSceneCacheReport;

int libredwg_write_scene_cache (
    Dwg_Data *dwg, const char *output_path, const char *preview_path,
    const char *preview_ready_path, uint64_t source_size,
    uint32_t source_version, LibreDwgSceneCacheReport *report,
    char *error_message, size_t error_message_size);

#endif
