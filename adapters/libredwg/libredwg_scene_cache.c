/*
 * SPDX-License-Identifier: MPL-2.0
 *
 * A bounded-memory Scene Cache v1.26 writer for GNU LibreDWG. Geometry and
 * source text are traversed repeatedly and written directly to the
 * destination; the writer never creates a JSON or whole-drawing in-memory
 * representation. Large detail passes use private temporary files for an
 * external XY Morton sort.
 */

#define _POSIX_C_SOURCE 200809L
#define _FILE_OFFSET_BITS 64
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#endif

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wextra-semi"
#pragma clang diagnostic ignored "-Wflexible-array-extensions"
#endif
#include <dwg.h>
#include <dwg_api.h>
#if defined(__clang__)
#pragma clang diagnostic pop
#endif

#include "libredwg_scene_cache.h"

#include <errno.h>
#include <fcntl.h>
#include <float.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#if defined(_WIN32)
#include <io.h>
#include <process.h>
#include <windows.h>
#define close _close
#define fdopen _fdopen
#define fileno _fileno
#define fseeko _fseeki64
#define ftello _ftelli64
#define open _open
#define unlink _unlink
#ifndef O_BINARY
#define O_BINARY _O_BINARY
#endif
typedef __int64 DwgViewerFileOffset;
#else
#if !defined(__EMSCRIPTEN__)
#include <pthread.h>
#endif
#include <unistd.h>
#define O_BINARY 0
typedef off_t DwgViewerFileOffset;
#endif

/*
 * LibreDWG's public dynapi text helper intentionally returns legacy TV
 * strings without converting them. The pinned 0.14 library exports this
 * converter, but does not expose its declaration from the installed public
 * headers.
 */
extern char *bit_TV_to_utf8 (const char *restrict src,
                             const BITCODE_RS codepage);
extern char *bit_convert_TU (const BITCODE_TU restrict src);
extern void dwg_resolve_objectrefs_silent (Dwg_Data *restrict dwg);

#define CACHE_VERSION_MAJOR LIBREDWG_SCENE_CACHE_VERSION_MAJOR
#define CACHE_VERSION_MINOR LIBREDWG_SCENE_CACHE_VERSION_MINOR
#define CACHE_HEADER_SIZE 64u
#define DIRECTORY_ENTRY_SIZE 40u
#define SECTION_FLAG_STRING_TABLE 1u
#define STRING_TABLE_HEADER_SIZE 16u
#define MAX_CACHE_STRING_BYTES (1024u * 1024u)
#define GPU_LINE_VERTEX_RECORD_SIZE 36u
#define MAX_GPU_DETAIL_BATCH_BYTES (512u * 1024u)
#define MAX_GPU_OVERVIEW_BYTES (4u * 1024u * 1024u)
#define GPU_BATCH_SEGMENTS                                             \
  (MAX_GPU_DETAIL_BATCH_BYTES / (2u * GPU_LINE_VERTEX_RECORD_SIZE))
#define SCENE_OVERVIEW_SEGMENTS                                       \
  (MAX_GPU_OVERVIEW_BYTES / (2u * GPU_LINE_VERTEX_RECORD_SIZE))
#define SPATIAL_SORT_RUN_SEGMENTS 8192u
#define SPATIAL_MERGE_BUFFER_RECORDS 64u
#if defined(__APPLE__) && defined(__x86_64__)
#define DWG_VIEWER_INTEL_MACOS_BUFFERED_WRITER 1
#define CACHE_WRITE_BUFFER_BYTES (64u * 1024u)
#endif
#define MAX_CONVERSION_WORKERS 8u
_Static_assert (
    GPU_BATCH_SEGMENTS * 2u * GPU_LINE_VERTEX_RECORD_SIZE
        <= MAX_GPU_DETAIL_BATCH_BYTES,
    "GPU detail batches must remain within the Webview range-read limit");
_Static_assert (
    SCENE_OVERVIEW_SEGMENTS * 2u * GPU_LINE_VERTEX_RECORD_SIZE
        <= MAX_GPU_OVERVIEW_BYTES,
    "GPU overview data must remain within the first-frame limit");
#define GPU_BATCH_FLAG_APPROXIMATED_CURVE 1u
#define GPU_STYLE_INVISIBLE (1u << 16)
#define GPU_STYLE_SOURCE_KIND_SHIFT 17u
#define GPU_STYLE_APPROXIMATED_CURVE (1u << 21)
#define GPU_STYLE_LINETYPE_SHIFT 5u
#define GPU_STYLE_LINETYPE_MASK 0x7ffu
#define TEXT_FLAG_HAS_ALIGNMENT_POINT 1u
#define TEXT_FLAG_HAS_RECTANGLE_HEIGHT (1u << 1)
#define TEXT_FLAG_ANNOTATIVE (1u << 2)
#define TEXT_FLAG_MULTILINE (1u << 3)
#define TEXT_FLAG_LOCK_POSITION (1u << 4)
#define TEXT_FLAG_REALLY_LOCKED (1u << 5)
#define CURVE_MAX_ANGLE_RADIANS 0.39269908169872415481
#define CURVE_FULL_TURN_RADIANS 6.28318530717958647693
#define CURVE_EPSILON 1.0e-12
#define MAX_CIRCULAR_SEGMENTS 16u
#define SPLINE_SEGMENTS_PER_SPAN 2u
#define MAX_SPLINE_DEGREE 15u
#define MAX_SPLINE_SEGMENTS 256u
#define HATCH_CURVE_MAX_ANGLE_RADIANS 0.09817477042468103870
#define MAX_HATCH_CIRCULAR_SEGMENTS 64u
#define HATCH_SPLINE_SEGMENTS_PER_SPAN 8u
#define MAX_HATCH_SPLINE_SEGMENTS 1024u
#define MAX_HATCH_BOUNDARY_SEGMENTS 262144u
#define MAX_HATCH_FILL_VERTICES 1048576u
#define MAX_HATCH_AUX_RECORDS 1048576u
#define MAX_HATCH_PATTERN_LINES_PER_ENTITY 4096u
#define MAX_HATCH_PATTERN_DASHES_PER_ENTITY 65536u
#define MAX_HATCH_PATTERN_LINES 262144u
#define MAX_HATCH_PATTERN_DASHES 1048576u
#define MAX_SOLID_SOURCE_RECORDS 131072u
#define MAX_WIPEOUT_SOURCE_RECORDS 65536u
#define MAX_WIPEOUT_CLIP_VERTICES 1048576u
#define MAX_IMAGE_SOURCE_RECORDS 65536u
#define MAX_IMAGE_CLIP_VERTICES 1048576u
#define MAX_EMBEDDED_IMAGE_BYTES (512u * 1024u * 1024u)
#define MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD (64u * 1024u * 1024u)
#define MAX_EMBEDDED_IMAGE_SCAN_BYTES (128u * 1024u * 1024u)
#define MAX_EMBEDDED_IMAGE_PIXELS 100000000u
#define MAX_EMBEDDED_EMF_RECORDS 200000u
#define MAX_EMBEDDED_WMFC_CHUNKS 65536u
#define WMFC_HEADER_SIZE 34u
#define WMFC_RECORD_PREFIX_SIZE 10u
#define MAX_DRAW_ORDER_TABLES 65536u
#define MAX_DRAW_ORDER_ENTRIES 1048576u
#define MAX_INSERT_CLIP_RECORDS 65536u
#define MAX_INSERT_CLIP_VERTICES 1048576u
#define MAX_INSERT_CLIP_VERTICES_PER_BOUNDARY 256u
#define MAX_VIEWPORT_CLIP_VERTICES 1048576u
#define MAX_VIEWPORT_CLIP_VERTICES_PER_BOUNDARY 4096u
#define MAX_VIEWPORT_LAYER_OVERRIDES 1048576u
#define VIEWPORT_CLIP_CURVE_SEGMENTS 64u
#define MAX_TEXT_ANNOTATION_CONTEXTS 262144u
#define MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS 1048576u
#define MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS_PER_CONTEXT 64u
#define MAX_MULTILEADER_NODES 65536u
#define MAX_MULTILEADER_LINES_PER_NODE 65536u
#define MAX_MULTILEADER_POINTS_PER_LINE 65536u
#define MAX_MULTILEADER_SEGMENTS_PER_ENTITY 262144u
#define MULTILEADER_SPLINE_SEGMENTS_PER_SPAN 8u
#define MAX_LEADER_POINTS_PER_ENTITY 65536u
#define MAX_ACIS_BYTES_PER_ENTITY (64u * 1024u * 1024u)
#define MAX_ACIS_RECORDS_PER_ENTITY 262144u
#define MAX_ACIS_TOKENS_PER_ENTITY 2097152u
#define MAX_ACIS_SEGMENTS_PER_ENTITY 262144u
#define MAX_ACIS_KNOTS 4096u
#define MAX_ACIS_CONTROL_POINTS 65536u
#define MAX_PROXY_GRAPHIC_BYTES (64u * 1024u * 1024u)
#define MAX_PROXY_GRAPHIC_CHUNKS 262144u
#define MAX_PROXY_GRAPHIC_MATRIX_DEPTH 32u
#define MAX_PROXY_GRAPHIC_VERTICES_PER_CHUNK 1048576u
#define MAX_PROXY_GRAPHIC_SEGMENTS_PER_ENTITY 262144u
#define MAX_PROXY_GRAPHIC_TEXTS_PER_ENTITY 262144u
#define MAX_PROXY_GRAPHIC_UTF16_UNITS (4u * 1024u * 1024u)
#define MAX_LINETYPE_DEFINITIONS 2045u
#define HATCH_FLAG_SOLID 1u
#define HATCH_FLAG_ASSOCIATIVE (1u << 1)
#define HATCH_FLAG_DOUBLE (1u << 2)
#define HATCH_FLAG_GRADIENT (1u << 3)
#define HATCH_FLAG_SINGLE_COLOR_GRADIENT (1u << 4)
#define HATCH_FLAG_TRUNCATED (1u << 5)
#define HATCH_FLAG_BACKGROUND_COLOR (1u << 6)
#define HATCH_LOOP_FLAG_APPROXIMATED_CURVE 1u
#define POLYLINE_FLAG_SPLINE_FIT (1u << 2)
#define POLYLINE_FLAG_CONTINUOUS_LINETYPE (1u << 7)
#define VERTEX_FLAG_CURVE_FIT_EXTRA (1u << 0)
#define VERTEX_FLAG_SPLINE_FIT_EXTRA (1u << 3)
#define VERTEX_FLAG_SPLINE_FRAME_CONTROL (1u << 4)
#define VIEWPORT_LAYER_OVERRIDE_COLOR 1u
#define VIEWPORT_LAYER_OVERRIDE_TRANSPARENCY 2u
#define VIEWPORT_LAYER_OVERRIDE_LINETYPE 3u
#define VIEWPORT_LAYER_OVERRIDE_LINEWEIGHT 4u

enum
{
  SECTION_DRAWING = 1,
  SECTION_LAYERS = 2,
  SECTION_BLOCKS = 3,
  SECTION_TEXT_STYLES = 4,
  SECTION_LINES = 10,
  SECTION_ARCS = 11,
  SECTION_CIRCLES = 12,
  SECTION_INSERTS = 13,
  SECTION_POLYLINE_HEADERS = 14,
  SECTION_POLYLINE_VERTICES = 15,
  SECTION_ELLIPSES = 16,
  SECTION_SPLINE_HEADERS = 17,
  SECTION_SPLINE_KNOTS = 18,
  SECTION_SPLINE_WEIGHTS = 19,
  SECTION_SPLINE_CONTROL_POINTS = 20,
  SECTION_SPLINE_FIT_POINTS = 21,
  SECTION_TEXT_ENTITIES = 22,
  SECTION_TEXT_COLUMN_HEIGHTS = 23,
  SECTION_GPU_LINE_BATCHES = 30,
  SECTION_GPU_LINE_VERTICES = 31,
  SECTION_HATCH_ENTITIES = 32,
  SECTION_HATCH_LOOPS = 33,
  SECTION_HATCH_VERTICES = 34,
  SECTION_HATCH_GRADIENT_COLORS = 35,
  SECTION_HATCH_SEED_POINTS = 36,
  SECTION_HATCH_PATTERN_LINES = 37,
  SECTION_HATCH_PATTERN_DASHES = 38,
  SECTION_POINT_ENTITIES = 39,
  SECTION_SOLID_ENTITIES = 40,
  SECTION_FACE_ENTITIES = 41,
  SECTION_WIPEOUT_ENTITIES = 42,
  SECTION_WIPEOUT_CLIP_VERTICES = 43,
  SECTION_DRAW_ORDER_TABLES = 44,
  SECTION_DRAW_ORDER_ENTRIES = 45,
  SECTION_INSERT_CLIPS = 46,
  SECTION_INSERT_CLIP_VERTICES = 47,
  SECTION_LINETYPES = 48,
  SECTION_LINETYPE_DASHES = 49,
  SECTION_LAYOUTS = 50,
  SECTION_VIEWPORTS = 51,
  SECTION_VIEWPORT_FROZEN_LAYERS = 52,
  SECTION_VIEWPORT_CLIP_VERTICES = 53,
  SECTION_IMAGE_ENTITIES = 54,
  SECTION_IMAGE_CLIP_VERTICES = 55,
  SECTION_TEXT_ANNOTATION_CONTEXTS = 56,
  SECTION_TEXT_ANNOTATION_COLUMN_HEIGHTS = 57,
  SECTION_VIEWPORT_LAYER_OVERRIDES = 58,
  SECTION_EMBEDDED_IMAGE_RECORDS = 59,
  SECTION_EMBEDDED_IMAGE_BYTES = 60,
  SECTION_CURVE_LINETYPE_SCALES = 61,
  SECTION_CONSTRUCTION_LINES = 62
};

enum
{
  DRAWING_RECORD_SIZE = 160,
  LAYER_RECORD_SIZE = 40,
  BLOCK_RECORD_SIZE = 64,
  TEXT_STYLE_RECORD_SIZE = 96,
  LINE_RECORD_SIZE = 80,
  ARC_RECORD_SIZE = 112,
  CIRCLE_RECORD_SIZE = 96,
  INSERT_RECORD_SIZE = 136,
  POLYLINE_HEADER_RECORD_SIZE = 112,
  POLYLINE_VERTEX_RECORD_SIZE = 64,
  ELLIPSE_RECORD_SIZE = 128,
  SPLINE_HEADER_RECORD_SIZE = 208,
  SPLINE_SCALAR_RECORD_SIZE = 8,
  SPLINE_POINT_RECORD_SIZE = 24,
  TEXT_ENTITY_RECORD_SIZE = 336,
  TEXT_COLUMN_HEIGHT_RECORD_SIZE = 8,
  GPU_LINE_BATCH_RECORD_SIZE = 128,
  HATCH_ENTITY_RECORD_SIZE = 192,
  HATCH_LOOP_RECORD_SIZE = 48,
  HATCH_VERTEX_RECORD_SIZE = 24,
  HATCH_GRADIENT_COLOR_RECORD_SIZE = 16,
  HATCH_SEED_POINT_RECORD_SIZE = 16,
  HATCH_PATTERN_LINE_RECORD_SIZE = 72,
  HATCH_PATTERN_DASH_RECORD_SIZE = 8,
  POINT_ENTITY_RECORD_SIZE = 112,
  SOLID_ENTITY_RECORD_SIZE = 168,
  FACE_ENTITY_RECORD_SIZE = 136,
  WIPEOUT_ENTITY_RECORD_SIZE = 168,
  WIPEOUT_CLIP_VERTEX_RECORD_SIZE = 16,
  DRAW_ORDER_TABLE_RECORD_SIZE = 40,
  DRAW_ORDER_ENTRY_RECORD_SIZE = 16,
  INSERT_CLIP_RECORD_SIZE = 32,
  INSERT_CLIP_VERTEX_RECORD_SIZE = 16,
  LINETYPE_RECORD_SIZE = 64,
  LINETYPE_DASH_RECORD_SIZE = 72,
  LAYOUT_RECORD_SIZE = 256,
  VIEWPORT_RECORD_SIZE = 272,
  VIEWPORT_FROZEN_LAYER_RECORD_SIZE = 8,
  VIEWPORT_CLIP_VERTEX_RECORD_SIZE = 16,
  IMAGE_ENTITY_RECORD_SIZE = 176,
  IMAGE_CLIP_VERTEX_RECORD_SIZE = 16,
  TEXT_ANNOTATION_CONTEXT_RECORD_SIZE = 160,
  TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE = 8,
  VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE = 24,
  EMBEDDED_IMAGE_RECORD_SIZE = 40,
  EMBEDDED_IMAGE_BYTE_RECORD_SIZE = 1,
  CURVE_LINETYPE_SCALE_RECORD_SIZE = 16,
  CONSTRUCTION_LINE_RECORD_SIZE = 80
};

typedef struct
{
  uint32_t kind;
  uint32_t record_size;
  uint64_t offset;
  uint64_t byte_length;
  uint64_t record_count;
  uint32_t flags;
  const char *name;
} SectionEntry;

typedef struct
{
  double center[3];
  double view_height;
  double view_width;
  double twist;
  uint32_t flags;
} SavedModelView;

typedef struct
{
  Dwg_Object *object;
  uint64_t handle;
  char *name;
  char *linetype;
} LayerEntry;

typedef struct
{
  Dwg_Object *object;
  uint64_t handle;
  char *name;
  char *xref_path;
  int is_model;
  int is_paper;
} BlockEntry;

typedef struct
{
  Dwg_Object *object;
  uint64_t handle;
  char *name;
  char *font_file;
  char *bigfont_file;
} TextStyleEntry;

typedef struct
{
  Dwg_Object *object;
  uint64_t handle;
  uint32_t code;
  char *name;
  char *description;
} LinetypeEntry;

typedef struct
{
  uint64_t handle;
  uint32_t index;
} HandleIndex;

typedef struct
{
  LayerEntry *layers;
  size_t layer_count;
  HandleIndex *layer_indices;
  BlockEntry *blocks;
  size_t block_count;
  HandleIndex *block_indices;
  TextStyleEntry *text_styles;
  size_t text_style_count;
  HandleIndex *text_style_indices;
  LinetypeEntry *linetypes;
  size_t linetype_count;
  HandleIndex *linetype_codes;
  size_t linetype_code_count;
  size_t source_linetype_count;
  size_t referenced_linetype_count;
  size_t omitted_referenced_linetype_count;
  uint64_t model_handle;
  uint64_t paper_handle;
  uint32_t presentation_settings;
} CacheTables;

typedef struct
{
  FILE *file;
  char *error;
  size_t error_size;
#if defined(DWG_VIEWER_INTEL_MACOS_BUFFERED_WRITER)
  size_t buffered;
  uint8_t buffer[CACHE_WRITE_BUFFER_BYTES];
#endif
  int failed;
} CacheWriter;

typedef struct
{
  const Dwg_Object *object;
  uint16_t kind;
  uint16_t flags;
  Dwg_Object_Ref *style;
  char *value;
  char *tag;
  char *prompt;
  uint64_t linked_handle;
  double insertion_point[3];
  double alignment_point[3];
  double normal[3];
  double x_axis_direction[3];
  double height;
  double width_factor;
  double rotation;
  double oblique_angle;
  double thickness;
  double rectangle_width;
  double rectangle_height;
  double extents_width;
  double extents_height;
  double line_spacing_factor;
  double background_scale;
  uint32_t background_color;
  int32_t background_transparency;
  int32_t background_flags;
  int32_t source_flags;
  int16_t horizontal_alignment;
  int16_t vertical_alignment;
  int16_t attachment;
  int16_t flow_direction;
  int16_t line_spacing_style;
  int16_t generation_flags;
  int16_t field_length;
  int16_t mtext_type;
  int32_t line_count;
  int32_t column_type;
  int32_t column_count;
  uint32_t column_flags;
  double column_width;
  double column_gutter;
  const double *column_heights;
  uint64_t column_height_count;
  uint64_t serialized_handle;
  uint32_t common_color;
  uint32_t common_linetype_code;
  int16_t common_line_weight;
  uint32_t style_index_override;
  int has_common_override;
  int has_style_index_override;
} TextSource;

typedef struct
{
  const uint8_t *data;
  size_t size;
  size_t offset;
  uint32_t expected_chunks;
  uint32_t chunks;
} ProxyGraphicReader;

typedef struct
{
  uint32_t type;
  const uint8_t *data;
  size_t size;
} ProxyGraphicChunk;

typedef struct
{
  double matrices[MAX_PROXY_GRAPHIC_MATRIX_DEPTH][16];
  size_t matrix_depth;
  uint32_t color;
  uint32_t linetype_code;
  int16_t line_weight;
} ProxyGraphicState;

enum
{
  PROXY_GRAPHIC_POLYLINE = 6,
  PROXY_GRAPHIC_POLYGON = 7,
  PROXY_GRAPHIC_ATTRIBUTE_COLOR = 14,
  PROXY_GRAPHIC_ATTRIBUTE_LINETYPE = 18,
  PROXY_GRAPHIC_ATTRIBUTE_TRUE_COLOR = 22,
  PROXY_GRAPHIC_ATTRIBUTE_LINEWEIGHT = 23,
  PROXY_GRAPHIC_PUSH_MATRIX = 29,
  PROXY_GRAPHIC_PUSH_MATRIX2 = 30,
  PROXY_GRAPHIC_POP_MATRIX = 31,
  PROXY_GRAPHIC_POLYLINE_WITH_NORMALS = 32,
  PROXY_GRAPHIC_UNICODE_TEXT2 = 38
};

typedef struct
{
  double start[3];
  double end[3];
  uint64_t handle;
  uint32_t layer_index;
  uint32_t color;
  int16_t line_weight;
  uint16_t flags;
  uint32_t group;
  uint8_t source_kind;
  uint8_t approximated_curve;
  uint16_t linetype_code;
  double linetype_scale;
  double pattern_start;
  double pattern_end;
} LineSegment;

typedef int (*LineSegmentConsumer) (void *context,
                                    const LineSegment *segment);

typedef struct
{
  double position[3];
  double bulge;
  double start_width;
  double end_width;
  double curve_tangent;
  uint32_t flags;
  int32_t id;
} PolylineVertex;

typedef int (*PolylineVertexConsumer) (void *context,
                                       const PolylineVertex *vertex);

typedef struct
{
  uint16_t kind;
  uint16_t flags;
  double elevation;
  double thickness;
  double normal[3];
  double default_start_width;
  double default_end_width;
  double constant_width;
  int closed;
} PolylineInfo;

typedef struct
{
  size_t degree;
  size_t control_count;
  size_t nonzero_spans;
  unsigned segments_per_span;
  unsigned segment_count;
  double domain_start;
  double domain_end;
  int uniform_domain;
} SplineSampling;

typedef struct
{
  size_t point_count;
  size_t source_segment_count;
  unsigned segment_count;
  int periodic;
} HatchFitSampling;

typedef struct
{
  CacheWriter *writer;
  LibreDwgGpuLineSummary *summary;
  uint32_t current_group;
  uint32_t count;
  uint32_t batch_flags;
  uint16_t lod_level;
  int separate_overview;
  int has_group;
  double min[3];
  double max[3];
  uint64_t first_vertex;
} BatchDirectoryBuilder;

typedef struct
{
  BatchDirectoryBuilder batches;
  CacheWriter *vertex_writer;
  LineSegment *segments;
  uint8_t *vertex_bytes;
  uint64_t vertices;
} GpuSectionBuilder;

typedef struct
{
  uint64_t count;
  uint64_t quota;
  uint64_t seen;
  uint64_t emitted;
  double midpoint_min[2];
  double midpoint_max[2];
  int has_midpoint_bounds;
} OverviewGroup;

typedef struct
{
  OverviewGroup *groups;
  size_t group_count;
  uint64_t quota_total;
} OverviewPlan;

typedef struct
{
  LineSegment segment;
  uint64_t source_order;
  uint32_t morton;
  uint32_t reserved;
} SpatialSegmentRecord;

typedef struct
{
  uint64_t start;
  uint64_t count;
} SpatialSortRun;

typedef struct
{
  FILE *file;
  SpatialSortRun *runs;
  size_t run_count;
  uint64_t count;
  uint64_t merge_nanoseconds;
} SpatialSegmentStore;

typedef struct
{
  uint64_t next;
  uint64_t remaining;
  size_t buffered;
  size_t position;
  SpatialSegmentRecord buffer[SPATIAL_MERGE_BUFFER_RECORDS];
} SpatialMergeRun;

typedef struct
{
  double (*vertices)[3];
  size_t vertex_count;
  uint32_t source_edge_count;
  int approximated_curve;
  double signed_area;
} HatchRing;

typedef struct
{
  LineSegment *segments;
  size_t capacity;
  size_t count;
} HatchSegmentCollector;

typedef int (*HatchRingConsumer) (
    void *context, const Dwg_Object *object,
    const Dwg_Entity_HATCH *hatch, uint64_t hatch_index,
    uint32_t path_index, const Dwg_HATCH_Path *path,
    const HatchRing *ring);

typedef struct
{
  uint64_t global_vertices;
  uint64_t global_gradient_colors;
  uint64_t global_seed_points;
  uint64_t loops;
  uint64_t vertices;
  uint64_t gradient_colors;
  uint64_t seed_points;
  uint64_t skipped_open_paths;
  uint64_t skipped_invalid_paths;
  int truncated;
} HatchEntityScan;

typedef struct
{
  uint64_t lines;
  uint64_t dashes;
  uint64_t invalid_lines;
  int truncated;
} HatchPatternScan;

typedef int (*HatchPatternLineConsumer) (
    void *context, uint64_t hatch_index, uint32_t source_line_index,
    const Dwg_HATCH_DefLine *line, uint64_t first_dash,
    uint32_t dash_count);

typedef struct
{
  OverviewPlan *overview;
  LineSegmentConsumer consumer;
  void *consumer_context;
  uint64_t emitted;
  uint64_t skipped;
  uint64_t approximated;
  uint64_t pattern_handle;
  double pattern_cursor;
  double pattern_end_point[3];
  int has_pattern_end;
} SegmentIteration;

static int segment_iteration_emit (SegmentIteration *iteration,
                                   const LineSegment *segment);
static void segment_iteration_reject (SegmentIteration *iteration);
static int is_viewport_entity (const Dwg_Object *object);
static int is_text_source_object (const Dwg_Object *object);

static uint32_t viewport_clip_vertex_count (
    const Dwg_Data *dwg, const CacheTables *tables,
    const Dwg_Entity_VIEWPORT *viewport);

static int write_viewport_clip_vertex_section (
    CacheWriter *writer, const Dwg_Data *dwg,
    const CacheTables *tables,
    SectionEntry *entry);

typedef struct
{
  uint64_t value;
  size_t index;
} GroupRank;

typedef struct
{
  const Dwg_Object *object;
  const Dwg_Object_SORTENTSTABLE *table;
  uint64_t table_handle;
  uint64_t owner_handle;
  uint32_t entry_count;
} DrawOrderTableSource;

typedef struct
{
  uint64_t entity_handle;
  uint64_t sort_handle;
} DrawOrderEntrySource;

static const uint8_t CACHE_MAGIC[8]
    = { 'D', 'W', 'G', 'S', 'C', 'N', '1', '\0' };
#define CACHE_HEADER_FLAG_PREVIEW 1u

static const uint32_t SECTION_KINDS[LIBREDWG_SCENE_SECTION_COUNT]
    = { SECTION_DRAWING,
        SECTION_LAYERS,
        SECTION_BLOCKS,
        SECTION_TEXT_STYLES,
        SECTION_LINES,
        SECTION_ARCS,
        SECTION_CIRCLES,
        SECTION_INSERTS,
        SECTION_POLYLINE_HEADERS,
        SECTION_POLYLINE_VERTICES,
        SECTION_ELLIPSES,
        SECTION_SPLINE_HEADERS,
        SECTION_SPLINE_KNOTS,
        SECTION_SPLINE_WEIGHTS,
        SECTION_SPLINE_CONTROL_POINTS,
        SECTION_SPLINE_FIT_POINTS,
        SECTION_TEXT_ENTITIES,
        SECTION_TEXT_COLUMN_HEIGHTS,
        SECTION_GPU_LINE_BATCHES,
        SECTION_GPU_LINE_VERTICES,
        SECTION_HATCH_ENTITIES,
        SECTION_HATCH_LOOPS,
        SECTION_HATCH_VERTICES,
        SECTION_HATCH_GRADIENT_COLORS,
        SECTION_HATCH_SEED_POINTS,
        SECTION_HATCH_PATTERN_LINES,
        SECTION_HATCH_PATTERN_DASHES,
        SECTION_POINT_ENTITIES,
        SECTION_SOLID_ENTITIES,
        SECTION_FACE_ENTITIES,
        SECTION_WIPEOUT_ENTITIES,
        SECTION_WIPEOUT_CLIP_VERTICES,
        SECTION_DRAW_ORDER_TABLES,
        SECTION_DRAW_ORDER_ENTRIES,
        SECTION_INSERT_CLIPS,
        SECTION_INSERT_CLIP_VERTICES,
        SECTION_LINETYPES,
        SECTION_LINETYPE_DASHES,
        SECTION_LAYOUTS,
        SECTION_VIEWPORTS,
        SECTION_VIEWPORT_FROZEN_LAYERS,
        SECTION_VIEWPORT_CLIP_VERTICES,
        SECTION_IMAGE_ENTITIES,
        SECTION_IMAGE_CLIP_VERTICES,
        SECTION_TEXT_ANNOTATION_CONTEXTS,
        SECTION_TEXT_ANNOTATION_COLUMN_HEIGHTS,
        SECTION_VIEWPORT_LAYER_OVERRIDES,
        SECTION_EMBEDDED_IMAGE_RECORDS,
        SECTION_EMBEDDED_IMAGE_BYTES,
        SECTION_CURVE_LINETYPE_SCALES,
        SECTION_CONSTRUCTION_LINES };

static const uint32_t SECTION_RECORD_SIZES[LIBREDWG_SCENE_SECTION_COUNT]
    = { DRAWING_RECORD_SIZE,
        LAYER_RECORD_SIZE,
        BLOCK_RECORD_SIZE,
        TEXT_STYLE_RECORD_SIZE,
        LINE_RECORD_SIZE,
        ARC_RECORD_SIZE,
        CIRCLE_RECORD_SIZE,
        INSERT_RECORD_SIZE,
        POLYLINE_HEADER_RECORD_SIZE,
        POLYLINE_VERTEX_RECORD_SIZE,
        ELLIPSE_RECORD_SIZE,
        SPLINE_HEADER_RECORD_SIZE,
        SPLINE_SCALAR_RECORD_SIZE,
        SPLINE_SCALAR_RECORD_SIZE,
        SPLINE_POINT_RECORD_SIZE,
        SPLINE_POINT_RECORD_SIZE,
        TEXT_ENTITY_RECORD_SIZE,
        TEXT_COLUMN_HEIGHT_RECORD_SIZE,
        GPU_LINE_BATCH_RECORD_SIZE,
        GPU_LINE_VERTEX_RECORD_SIZE,
        HATCH_ENTITY_RECORD_SIZE,
        HATCH_LOOP_RECORD_SIZE,
        HATCH_VERTEX_RECORD_SIZE,
        HATCH_GRADIENT_COLOR_RECORD_SIZE,
        HATCH_SEED_POINT_RECORD_SIZE,
        HATCH_PATTERN_LINE_RECORD_SIZE,
        HATCH_PATTERN_DASH_RECORD_SIZE,
        POINT_ENTITY_RECORD_SIZE,
        SOLID_ENTITY_RECORD_SIZE,
        FACE_ENTITY_RECORD_SIZE,
        WIPEOUT_ENTITY_RECORD_SIZE,
        WIPEOUT_CLIP_VERTEX_RECORD_SIZE,
        DRAW_ORDER_TABLE_RECORD_SIZE,
        DRAW_ORDER_ENTRY_RECORD_SIZE,
        INSERT_CLIP_RECORD_SIZE,
        INSERT_CLIP_VERTEX_RECORD_SIZE,
        LINETYPE_RECORD_SIZE,
        LINETYPE_DASH_RECORD_SIZE,
        LAYOUT_RECORD_SIZE,
        VIEWPORT_RECORD_SIZE,
        VIEWPORT_FROZEN_LAYER_RECORD_SIZE,
        VIEWPORT_CLIP_VERTEX_RECORD_SIZE,
        IMAGE_ENTITY_RECORD_SIZE,
        IMAGE_CLIP_VERTEX_RECORD_SIZE,
        TEXT_ANNOTATION_CONTEXT_RECORD_SIZE,
        TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE,
        VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE,
        EMBEDDED_IMAGE_RECORD_SIZE,
        EMBEDDED_IMAGE_BYTE_RECORD_SIZE,
        CURVE_LINETYPE_SCALE_RECORD_SIZE,
        CONSTRUCTION_LINE_RECORD_SIZE };

static const char *const SECTION_NAMES[LIBREDWG_SCENE_SECTION_COUNT]
    = { "drawing",
        "layers",
        "blocks",
        "text_styles",
        "lines",
        "arcs",
        "circles",
        "inserts",
        "polyline_headers",
        "polyline_vertices",
        "ellipses",
        "spline_headers",
        "spline_knots",
        "spline_weights",
        "spline_control_points",
        "spline_fit_points",
        "text_entities",
        "text_column_heights",
        "gpu_line_batches",
        "gpu_line_vertices",
        "hatch_entities",
        "hatch_loops",
        "hatch_vertices",
        "hatch_gradient_colors",
        "hatch_seed_points",
        "hatch_pattern_lines",
        "hatch_pattern_dashes",
        "point_entities",
        "solid_entities",
        "face_entities",
        "wipeout_entities",
        "wipeout_clip_vertices",
        "draw_order_tables",
        "draw_order_entries",
        "insert_clips",
        "insert_clip_vertices",
        "linetypes",
        "linetype_dashes",
        "layouts",
        "viewports",
        "viewport_frozen_layers",
        "viewport_clip_vertices",
        "image_entities",
        "image_clip_vertices",
        "text_annotation_contexts",
        "text_annotation_column_heights",
        "viewport_layer_overrides",
        "embedded_image_records",
        "embedded_image_bytes",
        "curve_linetype_scales",
        "construction_lines" };

static void
set_error (CacheWriter *writer, const char *message)
{
  if (writer->failed)
    return;
  writer->failed = 1;
  if (writer->error && writer->error_size)
    {
      (void)snprintf (writer->error, writer->error_size, "%s", message);
    }
}

static int
flush_writer (CacheWriter *writer)
{
#if defined(DWG_VIEWER_INTEL_MACOS_BUFFERED_WRITER)
  if (writer->failed)
    return 0;
  if (writer->buffered
      && fwrite (
             writer->buffer, 1, writer->buffered,
             writer->file)
             != writer->buffered)
    {
      set_error (writer, "cannot write scene cache");
      return 0;
    }
  writer->buffered = 0;
  return 1;
#else
  return !writer->failed;
#endif
}

static uint64_t
monotonic_nanoseconds (void)
{
#if defined(_WIN32)
  LARGE_INTEGER counter;
  LARGE_INTEGER frequency;
  uint64_t seconds;
  uint64_t remainder;
  if (!QueryPerformanceCounter (&counter)
      || !QueryPerformanceFrequency (&frequency)
      || counter.QuadPart < 0 || frequency.QuadPart <= 0)
    return 0;
  seconds = (uint64_t)counter.QuadPart / (uint64_t)frequency.QuadPart;
  remainder
      = (uint64_t)counter.QuadPart % (uint64_t)frequency.QuadPart;
  if (seconds > UINT64_MAX / 1000000000u)
    return 0;
  return seconds * 1000000000u
         + remainder * 1000000000u / (uint64_t)frequency.QuadPart;
#else
  struct timespec value;
  if (clock_gettime (CLOCK_MONOTONIC, &value) != 0
      || value.tv_sec < 0 || value.tv_nsec < 0)
    return 0;
  if ((uint64_t)value.tv_sec > UINT64_MAX / 1000000000u)
    return 0;
  return (uint64_t)value.tv_sec * 1000000000u
         + (uint64_t)value.tv_nsec;
#endif
}

static uint64_t
elapsed_nanoseconds (uint64_t started)
{
  uint64_t finished = monotonic_nanoseconds ();
  return started && finished >= started ? finished - started : 0;
}

static uint64_t
milliseconds_from_nanoseconds (uint64_t value)
{
  return value / 1000000u;
}

static uint32_t
conversion_worker_count (void)
{
  const char *configured = getenv ("DWG_VIEWER_CONVERSION_WORKERS");
  unsigned long parsed = 0;
  char *end = NULL;
  uint64_t available = 1;
  if (configured && configured[0])
    {
      errno = 0;
      parsed = strtoul (configured, &end, 10);
      if (!errno && end && *end == '\0' && parsed >= 1
          && parsed <= MAX_CONVERSION_WORKERS)
        return (uint32_t)parsed;
    }
#if defined(__EMSCRIPTEN__)
  available = 1;
#elif defined(_WIN32)
  available = (uint64_t)GetActiveProcessorCount (ALL_PROCESSOR_GROUPS);
#else
  {
    long processors = sysconf (_SC_NPROCESSORS_ONLN);
    available = processors > 0 ? (uint64_t)processors : 1u;
  }
#endif
  if (available > MAX_CONVERSION_WORKERS)
    available = MAX_CONVERSION_WORKERS;
  return (uint32_t)(available ? available : 1u);
}

static int
write_bytes (CacheWriter *writer, const void *value, size_t size)
{
#if defined(DWG_VIEWER_INTEL_MACOS_BUFFERED_WRITER)
  const uint8_t *bytes = (const uint8_t *)value;
  if (writer->failed)
    return 0;
  if (!writer->buffered && size >= sizeof (writer->buffer))
    {
      if (fwrite (value, 1, size, writer->file) != size)
        {
          set_error (writer, "cannot write scene cache");
          return 0;
        }
      return 1;
    }
  while (size)
    {
      size_t available = sizeof (writer->buffer) - writer->buffered;
      size_t copied = size < available ? size : available;
      memcpy (writer->buffer + writer->buffered, bytes, copied);
      writer->buffered += copied;
      bytes += copied;
      size -= copied;
      if (writer->buffered == sizeof (writer->buffer)
          && !flush_writer (writer))
        return 0;
    }
  return 1;
#else
  if (writer->failed)
    return 0;
  if (size && fwrite (value, 1, size, writer->file) != size)
    {
      set_error (writer, "cannot write scene cache");
      return 0;
    }
  return 1;
#endif
}

static int
write_u8 (CacheWriter *writer, uint8_t value)
{
  return write_bytes (writer, &value, sizeof (value));
}

static int
write_u16 (CacheWriter *writer, uint16_t value)
{
  uint8_t bytes[2] = { (uint8_t)value, (uint8_t)(value >> 8) };
  return write_bytes (writer, bytes, sizeof (bytes));
}

static int
write_i16 (CacheWriter *writer, int16_t value)
{
  return write_u16 (writer, (uint16_t)value);
}

static int
write_u32 (CacheWriter *writer, uint32_t value)
{
  uint8_t bytes[4] = { (uint8_t)value, (uint8_t)(value >> 8),
                       (uint8_t)(value >> 16), (uint8_t)(value >> 24) };
  return write_bytes (writer, bytes, sizeof (bytes));
}

static int
write_i32 (CacheWriter *writer, int32_t value)
{
  return write_u32 (writer, (uint32_t)value);
}

static int
write_u64 (CacheWriter *writer, uint64_t value)
{
  uint8_t bytes[8] = { (uint8_t)value,
                       (uint8_t)(value >> 8),
                       (uint8_t)(value >> 16),
                       (uint8_t)(value >> 24),
                       (uint8_t)(value >> 32),
                       (uint8_t)(value >> 40),
                       (uint8_t)(value >> 48),
                       (uint8_t)(value >> 56) };
  return write_bytes (writer, bytes, sizeof (bytes));
}

static int
write_f32 (CacheWriter *writer, float value)
{
  uint32_t encoded;
  memcpy (&encoded, &value, sizeof (encoded));
  return write_u32 (writer, encoded);
}

static void
store_u32_le (uint8_t *bytes, uint32_t value)
{
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8);
  bytes[2] = (uint8_t)(value >> 16);
  bytes[3] = (uint8_t)(value >> 24);
}

static void
store_f32_le (uint8_t *bytes, float value)
{
  uint32_t encoded;
  memcpy (&encoded, &value, sizeof (encoded));
  store_u32_le (bytes, encoded);
}

static int
write_f64 (CacheWriter *writer, double value)
{
  uint64_t encoded;
  memcpy (&encoded, &value, sizeof (encoded));
  return write_u64 (writer, encoded);
}

static int
write_vec3 (CacheWriter *writer, const double value[3])
{
  return write_f64 (writer, value[0]) && write_f64 (writer, value[1])
         && write_f64 (writer, value[2]);
}

static uint64_t
align_up (uint64_t value, uint64_t alignment)
{
  return (value + alignment - 1u) & ~(alignment - 1u);
}

static int
position (CacheWriter *writer, uint64_t *value)
{
  DwgViewerFileOffset result;
  if (!flush_writer (writer))
    return 0;
  result = ftello (writer->file);
  if (result < 0)
    {
      set_error (writer, "cannot read scene-cache position");
      return 0;
    }
  *value = (uint64_t)result;
  return 1;
}

static int
seek_to (CacheWriter *writer, uint64_t value)
{
  if (!flush_writer (writer))
    return 0;
  if (value > (uint64_t)INT64_MAX
      || fseeko (
             writer->file, (DwgViewerFileOffset)value, SEEK_SET)
             != 0)
    {
      set_error (writer, "cannot seek in scene cache");
      return 0;
    }
  return 1;
}

static int
align_writer (CacheWriter *writer, uint64_t *offset)
{
  uint64_t current;
  uint64_t aligned;
  static const uint8_t zeros[8] = { 0 };
  if (!position (writer, &current))
    return 0;
  aligned = align_up (current, 8);
  if (aligned > current
      && !write_bytes (writer, zeros, (size_t)(aligned - current)))
    return 0;
  *offset = aligned;
  return 1;
}

static int
finish_fixed_section (CacheWriter *writer, SectionEntry *entry,
                      uint32_t kind, uint32_t record_size, const char *name,
                      uint64_t offset, uint64_t count)
{
  uint64_t end;
  uint64_t expected;
  if (!position (writer, &end))
    return 0;
  if (count > UINT64_MAX / record_size)
    {
      set_error (writer, "scene-cache section size overflow");
      return 0;
    }
  expected = count * record_size;
  if (end < offset || end - offset != expected)
    {
      set_error (writer, "scene-cache fixed section size mismatch");
      return 0;
    }
  entry->kind = kind;
  entry->record_size = record_size;
  entry->offset = offset;
  entry->byte_length = expected;
  entry->record_count = count;
  entry->flags = 0;
  entry->name = name;
  return 1;
}

static int
finish_variable_section (CacheWriter *writer, SectionEntry *entry,
                         uint32_t kind, uint32_t record_size,
                         const char *name, uint64_t offset, uint64_t count,
                         uint32_t flags)
{
  uint64_t end;
  if (!position (writer, &end) || end < offset)
    return 0;
  entry->kind = kind;
  entry->record_size = record_size;
  entry->offset = offset;
  entry->byte_length = end - offset;
  entry->record_count = count;
  entry->flags = flags;
  entry->name = name;
  return 1;
}

static uint64_t
reference_handle (const Dwg_Object_Ref *reference)
{
  if (!reference)
    return 0;
  if (reference->absolute_ref)
    return (uint64_t)reference->absolute_ref;
  if (reference->obj)
    return (uint64_t)reference->obj->handle.value;
  return (uint64_t)reference->handleref.value;
}

static Dwg_Object *
reference_object (const Dwg_Data *dwg, Dwg_Object_Ref *reference)
{
  uint64_t handle;
  if (!reference)
    return NULL;
  if (reference->obj)
    return reference->obj;
  if (!dwg->dirty_refs)
    {
      handle = reference_handle (reference);
      return handle
                 ? dwg_resolve_handle_silent (dwg, (BITCODE_HV)handle)
                 : NULL;
    }
  return dwg_ref_object_silent ((Dwg_Data *)dwg, reference);
}

static char *
copy_valid_utf8 (const char *source)
{
  const unsigned char *cursor = (const unsigned char *)source;
  size_t source_length = strlen (source);
  size_t input_offset = 0;
  size_t output_capacity;
  size_t output_length = 0;
  char *output;

  if (source_length > MAX_CACHE_STRING_BYTES
      || source_length > (SIZE_MAX - 1) / 3)
    return NULL;
  output_capacity = source_length * 3 + 1;
  output = (char *)malloc (output_capacity);
  if (!output)
    return NULL;

  while (*cursor)
    {
      size_t remaining = source_length - input_offset;
      size_t sequence_length = 0;
      unsigned char byte = cursor[0];

      if (byte <= 0x7f)
        sequence_length = 1;
      else if (remaining >= 2 && byte >= 0xc2 && byte <= 0xdf
               && cursor[1] >= 0x80 && cursor[1] <= 0xbf)
        sequence_length = 2;
      else if (remaining >= 3 && byte == 0xe0
               && cursor[1] >= 0xa0 && cursor[1] <= 0xbf
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf)
        sequence_length = 3;
      else if (remaining >= 3 && byte >= 0xe1 && byte <= 0xec
               && cursor[1] >= 0x80 && cursor[1] <= 0xbf
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf)
        sequence_length = 3;
      else if (remaining >= 3 && byte == 0xed
               && cursor[1] >= 0x80 && cursor[1] <= 0x9f
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf)
        sequence_length = 3;
      else if (remaining >= 3 && byte >= 0xee && byte <= 0xef
               && cursor[1] >= 0x80 && cursor[1] <= 0xbf
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf)
        sequence_length = 3;
      else if (remaining >= 4 && byte == 0xf0
               && cursor[1] >= 0x90 && cursor[1] <= 0xbf
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf
               && cursor[3] >= 0x80 && cursor[3] <= 0xbf)
        sequence_length = 4;
      else if (remaining >= 4 && byte >= 0xf1 && byte <= 0xf3
               && cursor[1] >= 0x80 && cursor[1] <= 0xbf
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf
               && cursor[3] >= 0x80 && cursor[3] <= 0xbf)
        sequence_length = 4;
      else if (remaining >= 4 && byte == 0xf4
               && cursor[1] >= 0x80 && cursor[1] <= 0x8f
               && cursor[2] >= 0x80 && cursor[2] <= 0xbf
               && cursor[3] >= 0x80 && cursor[3] <= 0xbf)
        sequence_length = 4;

      if (sequence_length)
        {
          if (output_length + sequence_length > MAX_CACHE_STRING_BYTES)
            {
              free (output);
              return NULL;
            }
          memcpy (output + output_length, cursor, sequence_length);
          output_length += sequence_length;
          cursor += sequence_length;
          input_offset += sequence_length;
        }
      else
        {
          if (output_length + 3 > MAX_CACHE_STRING_BYTES)
            {
              free (output);
              return NULL;
            }
          output[output_length++] = (char)0xef;
          output[output_length++] = (char)0xbf;
          output[output_length++] = (char)0xbd;
          cursor++;
          input_offset++;
        }
    }
  output[output_length] = '\0';
  return output;
}

static char *
copy_utf8_field (BITCODE_RS codepage, void *value, const char *type,
                 const char *field, const char *fallback)
{
  char *text = NULL;
  char *converted = NULL;
  char *copy;
  const char *source;
  int is_new = 0;

  if (value && dwg_dynapi_entity_utf8text (value, type, field, &text, &is_new,
                                           NULL)
      && text)
    fallback = text;
  source = fallback;
  if (!is_new)
    {
      converted = bit_TV_to_utf8 (fallback, codepage);
      if (!converted)
        return NULL;
      source = converted;
    }
  copy = copy_valid_utf8 (source);
  if (converted && converted != fallback)
    free (converted);
  if (is_new)
    free (text);
  return copy;
}

static char *
copy_block_name (Dwg_Data *dwg, Dwg_Object_BLOCK_HEADER *block)
{
  Dwg_Object *block_entity
      = reference_object (dwg, block ? block->block_entity : NULL);
  if (block_entity && block_entity->fixedtype == DWG_TYPE_BLOCK
      && block_entity->tio.entity
      && block_entity->tio.entity->tio.BLOCK)
    return copy_utf8_field (
        dwg->header.codepage, block_entity->tio.entity->tio.BLOCK,
        "BLOCK", "name", "");
  return copy_utf8_field (dwg->header.codepage, block, "BLOCK_HEADER",
                          "name", "");
}

static char *
copy_versioned_text (BITCODE_RS codepage, Dwg_Version_Type version,
                     const BITCODE_T value)
{
  char *converted;
  char *copy;
  if (!value)
    return copy_valid_utf8 ("");
  converted
      = version >= R_2007
            ? bit_convert_TU ((const BITCODE_TU)value)
            : bit_TV_to_utf8 ((const char *)value, codepage);
  if (!converted)
    return NULL;
  copy = copy_valid_utf8 (converted);
  free (converted);
  return copy;
}

static char *
copy_variable_dictionary_value (Dwg_Data *dwg, const char *name)
{
  const char *value;
  if (!dwg || !name)
    return NULL;
  value = dwg_variable_dict (dwg, name);
  return value ? copy_versioned_text (dwg->header.codepage,
                                      dwg->header.version,
                                      (const BITCODE_T)value)
               : NULL;
}

static Dwg_Object *
dictionary_item_named (const Dwg_Data *dwg, Dwg_Object *object,
                       const char *name)
{
  Dwg_Object_DICTIONARY *dictionary;
  uint32_t index;
  if (!dwg || !object || !name
      || object->fixedtype != DWG_TYPE_DICTIONARY
      || !object->tio.object
      || !(dictionary = object->tio.object->tio.DICTIONARY)
      || dictionary->numitems <= 0 || !dictionary->texts
      || !dictionary->itemhandles)
    return NULL;
  for (index = 0; index < (uint32_t)dictionary->numitems; index++)
    {
      char *key = copy_versioned_text (
          dwg->header.codepage, dwg->header.version,
          dictionary->texts[index]);
      int matches = key && strcmp (key, name) == 0;
      free (key);
      if (matches)
        return reference_object (dwg, dictionary->itemhandles[index]);
    }
  return NULL;
}

static double
annotation_scale_factor_for_object (const Dwg_Object *object)
{
  const Dwg_Object_SCALE *scale;
  if (!object || object->fixedtype != DWG_TYPE_SCALE
      || !object->tio.object
      || !(scale = object->tio.object->tio.SCALE)
      || !isfinite (scale->paper_units)
      || !isfinite (scale->drawing_units)
      || scale->paper_units <= DBL_EPSILON
      || scale->drawing_units <= DBL_EPSILON)
    return 0.0;
  return scale->drawing_units / scale->paper_units;
}

static double
annotation_scale_factor (const Dwg_Data *dwg,
                         Dwg_Object_Ref *reference)
{
  return annotation_scale_factor_for_object (
      reference_object (dwg, reference));
}

static double
model_annotation_scale (Dwg_Data *dwg)
{
  char *current_name = copy_variable_dictionary_value (dwg, "CANNOSCALE");
  size_t object_index;
  if (!dwg->header_vars.TILEMODE || !current_name || !current_name[0])
    {
      free (current_name);
      return 0.0;
    }
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      char *name;
      double factor;
      if (object->fixedtype != DWG_TYPE_SCALE || !object->tio.object
          || !object->tio.object->tio.SCALE)
        continue;
      name = copy_utf8_field (
          dwg->header.codepage, object->tio.object->tio.SCALE,
          "SCALE", "name", "");
      if (!name)
        continue;
      if (strcmp (name, current_name) != 0)
        {
          free (name);
          continue;
        }
      free (name);
      factor = annotation_scale_factor_for_object (object);
      free (current_name);
      return factor <= FLT_MAX ? factor : 0.0;
    }
  free (current_name);
  return 0.0;
}

static double
viewport_annotation_scale (const Dwg_Data *dwg,
                           const Dwg_Object *object)
{
  Dwg_Object *xdic;
  Dwg_Object *xrecord_object;
  Dwg_Object_XRECORD *xrecord;
  Dwg_Resbuf *item;
  if (!dwg || !object || !object->tio.entity
      || !object->tio.entity->xdicobjhandle)
    return 0.0;
  xdic = reference_object (dwg, object->tio.entity->xdicobjhandle);
  xrecord_object = dictionary_item_named (
      dwg, xdic, "ASDK_XREC_ANNOTATION_SCALE_INFO");
  if (!xrecord_object || xrecord_object->fixedtype != DWG_TYPE_XRECORD
      || !xrecord_object->tio.object
      || !(xrecord = xrecord_object->tio.object->tio.XRECORD))
    return 0.0;
  for (item = xrecord->xdata; item; item = item->nextrb)
    if (item->type == 340 && item->value.absref)
      {
        double scale = annotation_scale_factor_for_object (
            dwg_resolve_handle_silent (dwg, item->value.absref));
        if (scale > 0.0)
          return scale;
      }
  return 0.0;
}

static Dwg_Object_DICTIONARY *
text_annotation_context_dictionary (const Dwg_Data *dwg,
                                    const Dwg_Object *object)
{
  Dwg_Object *xdic;
  Dwg_Object *manager;
  Dwg_Object *scales;
  if (!dwg || !object || !object->tio.entity
      || !object->tio.entity->xdicobjhandle)
    return NULL;
  xdic = reference_object (dwg, object->tio.entity->xdicobjhandle);
  manager = dictionary_item_named (
      dwg, xdic, "AcDbContextDataManager");
  scales = dictionary_item_named (
      dwg, manager, "ACDB_ANNOTATIONSCALES");
  if (!scales || scales->fixedtype != DWG_TYPE_DICTIONARY
      || !scales->tio.object)
    return NULL;
  return scales->tio.object->tio.DICTIONARY;
}

static int
valid_mtext_annotation_context (
    const Dwg_Data *dwg, Dwg_Object *object,
    const Dwg_Object_MTEXTOBJECTCONTEXTDATA **result,
    double *scale_factor)
{
  const Dwg_Object_MTEXTOBJECTCONTEXTDATA *context;
  double scale;
  uint32_t index;
  if (!object
      || object->fixedtype != DWG_TYPE_MTEXTOBJECTCONTEXTDATA
      || !object->tio.object
      || !(context = object->tio.object->tio.MTEXTOBJECTCONTEXTDATA))
    return 0;
  scale = annotation_scale_factor (dwg, context->scale);
  if (!isfinite (scale) || scale <= DBL_EPSILON
      || context->class_version < 3 || context->class_version > 4
      || context->attachment < 1 || context->attachment > 9
      || !isfinite (context->ins_pt.x)
      || !isfinite (context->ins_pt.y)
      || !isfinite (context->ins_pt.z)
      || !isfinite (context->x_axis_dir.x)
      || !isfinite (context->x_axis_dir.y)
      || !isfinite (context->x_axis_dir.z)
      || hypot (hypot (context->x_axis_dir.x, context->x_axis_dir.y),
                context->x_axis_dir.z)
             <= DBL_EPSILON
      || !isfinite (context->rect_height)
      || !isfinite (context->rect_width)
      || !isfinite (context->extents_width)
      || !isfinite (context->extents_height)
      || context->rect_height < 0.0 || context->rect_width < 0.0
      || context->extents_width < 0.0
      || context->extents_height < 0.0
      || context->column_type > 2
      || !isfinite (context->column_width)
      || !isfinite (context->gutter)
      || context->column_width < 0.0 || context->gutter < 0.0
      || context->num_column_heights
             > MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS_PER_CONTEXT
      || (context->num_column_heights > 0
          && !context->column_heights))
    return 0;
  for (index = 0; index < (uint32_t)context->num_column_heights;
       index++)
    if (!isfinite (context->column_heights[index]))
      return 0;
  if (result)
    *result = context;
  if (scale_factor)
    *scale_factor = scale;
  return 1;
}

typedef struct
{
  int is_default;
  int32_t horizontal_mode;
  double scale;
  double rotation;
  double insertion_point[3];
  double alignment_point[3];
} TextAnnotationContext;

static double
text_entity_elevation (const Dwg_Object *object)
{
  if (!object || !object->tio.entity)
    return 0.0;
  switch (object->fixedtype)
    {
    case DWG_TYPE_TEXT:
      return object->tio.entity->tio.TEXT
                 ? object->tio.entity->tio.TEXT->elevation
                 : 0.0;
    case DWG_TYPE_ATTDEF:
      return object->tio.entity->tio.ATTDEF
                 ? object->tio.entity->tio.ATTDEF->elevation
                 : 0.0;
    case DWG_TYPE_ATTRIB:
      return object->tio.entity->tio.ATTRIB
                 ? object->tio.entity->tio.ATTRIB->elevation
                 : 0.0;
    default:
      return 0.0;
    }
}

static int
valid_text_annotation_context (const Dwg_Data *dwg,
                               const Dwg_Object *text_object,
                               Dwg_Object *object,
                               TextAnnotationContext *result)
{
  BITCODE_BS class_version;
  BITCODE_B is_default;
  BITCODE_H scale_ref;
  BITCODE_BS horizontal_mode;
  BITCODE_BD rotation;
  BITCODE_2RD insertion;
  BITCODE_2RD alignment;
  double scale;
  double elevation;
  if (!object || !object->tio.object || !result)
    return 0;
  if (object->fixedtype == DWG_TYPE_TEXTOBJECTCONTEXTDATA
      && object->tio.object->tio.TEXTOBJECTCONTEXTDATA)
    {
      const Dwg_Object_TEXTOBJECTCONTEXTDATA *context
          = object->tio.object->tio.TEXTOBJECTCONTEXTDATA;
      class_version = context->class_version;
      is_default = context->is_default;
      scale_ref = context->scale;
      horizontal_mode = context->horizontal_mode;
      rotation = context->rotation;
      insertion = context->ins_pt;
      alignment = context->alignment_pt;
    }
  else if (
      object->fixedtype == DWG_TYPE_MTEXTATTRIBUTEOBJECTCONTEXTDATA
      && object->tio.object->tio.MTEXTATTRIBUTEOBJECTCONTEXTDATA)
    {
      const Dwg_Object_MTEXTATTRIBUTEOBJECTCONTEXTDATA *context
          = object->tio.object->tio.MTEXTATTRIBUTEOBJECTCONTEXTDATA;
      class_version = context->class_version;
      is_default = context->is_default;
      scale_ref = context->scale;
      horizontal_mode = context->horizontal_mode;
      rotation = context->rotation;
      insertion = context->ins_pt;
      alignment = context->alignment_pt;
    }
  else
    return 0;
  scale = annotation_scale_factor (dwg, scale_ref);
  if (!isfinite (scale) || scale <= DBL_EPSILON
      || class_version < 3 || class_version > 4
      || horizontal_mode > 5 || !isfinite (rotation)
      || !isfinite (insertion.x) || !isfinite (insertion.y)
      || !isfinite (alignment.x) || !isfinite (alignment.y))
    return 0;
  elevation = text_entity_elevation (text_object);
  if (!isfinite (elevation))
    elevation = 0.0;
  memset (result, 0, sizeof (*result));
  result->is_default = is_default ? 1 : 0;
  result->horizontal_mode = (int32_t)horizontal_mode;
  result->scale = scale;
  result->rotation = rotation;
  result->insertion_point[0] = insertion.x;
  result->insertion_point[1] = insertion.y;
  result->insertion_point[2] = elevation;
  result->alignment_point[0] = alignment.x;
  result->alignment_point[1] = alignment.y;
  result->alignment_point[2] = elevation;
  return 1;
}

static int
is_supported_text_annotation_owner (const Dwg_Object *object)
{
  return object
         && (object->fixedtype == DWG_TYPE_MTEXT
             || object->fixedtype == DWG_TYPE_TEXT
             || object->fixedtype == DWG_TYPE_ATTDEF
             || object->fixedtype == DWG_TYPE_ATTRIB);
}

static uint32_t
text_annotation_context_count (const Dwg_Data *dwg,
                               const Dwg_Object *object,
                               uint64_t *column_height_count)
{
  Dwg_Object_DICTIONARY *dictionary
      = text_annotation_context_dictionary (dwg, object);
  uint32_t count = 0;
  uint32_t index;
  if (column_height_count)
    *column_height_count = 0;
  if (!dictionary || dictionary->numitems <= 0
      || !dictionary->itemhandles)
    return 0;
  for (index = 0; index < (uint32_t)dictionary->numitems; index++)
    {
      const Dwg_Object_MTEXTOBJECTCONTEXTDATA *context = NULL;
      TextAnnotationContext text_context;
      Dwg_Object *context_object
          = reference_object (dwg, dictionary->itemhandles[index]);
      if (object->fixedtype == DWG_TYPE_MTEXT)
        {
          if (!valid_mtext_annotation_context (
                  dwg, context_object, &context, NULL))
            continue;
        }
      else if (!valid_text_annotation_context (
                   dwg, object, context_object, &text_context))
        continue;
      if (count == MAX_TEXT_ANNOTATION_CONTEXTS)
        return count;
      count++;
      if (column_height_count && context)
        {
          if (*column_height_count
              > MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS
                    - context->num_column_heights)
            return count;
          *column_height_count += context->num_column_heights;
        }
    }
  return count;
}

static char *
copy_linetype_name (BITCODE_RS codepage,
                    const Dwg_Object_Ref *reference)
{
  Dwg_Object *object = reference ? reference->obj : NULL;
  if (!object || object->fixedtype != DWG_TYPE_LTYPE || !object->tio.object
      || !object->tio.object->tio.LTYPE)
    return copy_utf8_field (codepage, NULL, "", "", "Continuous");
  return copy_utf8_field (codepage, object->tio.object->tio.LTYPE, "LTYPE",
                          "name", "Continuous");
}

static int
handle_index_compare (const void *left, const void *right)
{
  const HandleIndex *a = (const HandleIndex *)left;
  const HandleIndex *b = (const HandleIndex *)right;
  if (a->handle < b->handle)
    return -1;
  if (a->handle > b->handle)
    return 1;
  return a->index < b->index ? -1 : a->index > b->index;
}

static uint32_t
find_handle_index (const HandleIndex *indices, size_t count, uint64_t handle)
{
  size_t left = 0;
  size_t right = count;
  while (left < right)
    {
      size_t middle = left + (right - left) / 2;
      if (indices[middle].handle < handle)
        left = middle + 1;
      else
        right = middle;
    }
  if (left < count && indices[left].handle == handle)
    return indices[left].index;
  return UINT32_MAX;
}

static size_t
drawing_object_index (const Dwg_Data *dwg, const Dwg_Object *object)
{
  if (!dwg || !dwg->object || !object || object < dwg->object
      || object >= dwg->object + dwg->num_objects)
    return SIZE_MAX;
  return (size_t)(object - dwg->object);
}

static void
mark_linetype_reference (const Dwg_Data *dwg,
                         Dwg_Object_Ref *reference,
                         unsigned char *referenced)
{
  Dwg_Object *object = reference_object (dwg, reference);
  size_t index = drawing_object_index (dwg, object);
  if (referenced && index != SIZE_MAX
      && object->fixedtype == DWG_TYPE_LTYPE)
    referenced[index] = 1u;
}

static double
normalized_linetype_number (double value, double fallback)
{
  return isfinite (value) ? value : fallback;
}

static int
simple_linetypes_equal (const Dwg_Object_LTYPE *left,
                        const Dwg_Object_LTYPE *right)
{
  size_t index;
  if (!left || !right || left->alignment != right->alignment
      || left->numdashes != right->numdashes
      || fabs (normalized_linetype_number (left->pattern_len, 0.0))
             != fabs (normalized_linetype_number (right->pattern_len, 0.0))
      || (left->numdashes > 0 && (!left->dashes || !right->dashes)))
    return 0;
  for (index = 0; index < (size_t)left->numdashes; index++)
    {
      const Dwg_LTYPE_dash *a = &left->dashes[index];
      const Dwg_LTYPE_dash *b = &right->dashes[index];
      if (a->shape_flag || b->shape_flag || a->length != b->length
          || a->complex_shapecode != b->complex_shapecode
          || reference_handle (a->style) != reference_handle (b->style)
          || normalized_linetype_number (a->x_offset, 0.0)
                 != normalized_linetype_number (b->x_offset, 0.0)
          || normalized_linetype_number (a->y_offset, 0.0)
                 != normalized_linetype_number (b->y_offset, 0.0)
          || normalized_linetype_number (a->scale, 1.0)
                 != normalized_linetype_number (b->scale, 1.0)
          || normalized_linetype_number (a->rotation, 0.0)
                 != normalized_linetype_number (b->rotation, 0.0))
        return 0;
    }
  return 1;
}

static int
linetype_special_code (const Dwg_Data *dwg, uint64_t handle,
                       uint32_t *code)
{
  if (handle
      && handle == reference_handle (dwg->header_vars.LTYPE_BYLAYER))
    *code = 0u;
  else if (handle
           && handle
                  == reference_handle (dwg->header_vars.LTYPE_BYBLOCK))
    *code = 1u;
  else if (handle
           && handle
                  == reference_handle (dwg->header_vars.LTYPE_CONTINUOUS))
    *code = 2u;
  else
    return 0;
  return 1;
}

static uint32_t
equivalent_linetype_code (const CacheTables *tables,
                          const Dwg_Object_LTYPE *candidate)
{
  size_t index;
  for (index = 0; index < tables->linetype_count; index++)
    {
      const LinetypeEntry *entry = &tables->linetypes[index];
      const Dwg_Object_LTYPE *existing
          = entry->object->tio.object->tio.LTYPE;
      if (entry->code >= 3u
          && simple_linetypes_equal (existing, candidate))
        return entry->code;
    }
  return UINT32_MAX;
}

static int
append_linetype_definition (const Dwg_Data *dwg, CacheTables *tables,
                            Dwg_Object *object, uint32_t code)
{
  LinetypeEntry *entry;
  Dwg_Object_LTYPE *linetype;
  if (!object || object->fixedtype != DWG_TYPE_LTYPE
      || !object->tio.object
      || !(linetype = object->tio.object->tio.LTYPE)
      || tables->linetype_count >= MAX_LINETYPE_DEFINITIONS)
    return 0;
  entry = &tables->linetypes[tables->linetype_count];
  entry->object = object;
  entry->handle = (uint64_t)object->handle.value;
  entry->code = code;
  entry->name = copy_utf8_field (dwg->header.codepage, linetype, "LTYPE",
                                 "name", "Continuous");
  entry->description = copy_utf8_field (
      dwg->header.codepage, linetype, "LTYPE", "description", "");
  if (!entry->name || !entry->description)
    {
      free (entry->name);
      free (entry->description);
      memset (entry, 0, sizeof (*entry));
      return 0;
    }
  tables->linetype_count++;
  return 1;
}

static int
register_linetype (const Dwg_Data *dwg, CacheTables *tables,
                   Dwg_Object *object, int referenced,
                   unsigned char *processed, uint32_t *next_code)
{
  size_t object_index = drawing_object_index (dwg, object);
  uint64_t handle;
  uint32_t code;
  Dwg_Object_LTYPE *linetype;
  if (object_index == SIZE_MAX || !processed || processed[object_index]
      || object->fixedtype != DWG_TYPE_LTYPE || !object->tio.object
      || !(linetype = object->tio.object->tio.LTYPE))
    return 1;
  handle = (uint64_t)object->handle.value;
  if (linetype_special_code (dwg, handle, &code))
    {
      if (!append_linetype_definition (dwg, tables, object, code))
        return 0;
    }
  else
    {
      code = equivalent_linetype_code (tables, linetype);
      if (code == UINT32_MAX)
        {
          if (tables->linetype_count < MAX_LINETYPE_DEFINITIONS
              && *next_code <= 2047u)
            {
              code = (*next_code)++;
              if (!append_linetype_definition (
                      dwg, tables, object, code))
                return 0;
            }
          else
            {
              code = 2u;
              if (referenced)
                tables->omitted_referenced_linetype_count++;
            }
        }
    }
  tables->linetype_codes[tables->linetype_code_count].handle = handle;
  tables->linetype_codes[tables->linetype_code_count].index = code;
  tables->linetype_code_count++;
  processed[object_index] = 1u;
  return 1;
}

static void
free_tables (CacheTables *tables)
{
  size_t i;
  for (i = 0; i < tables->layer_count; i++)
    {
      free (tables->layers[i].name);
      free (tables->layers[i].linetype);
    }
  for (i = 0; i < tables->block_count; i++)
    {
      free (tables->blocks[i].name);
      free (tables->blocks[i].xref_path);
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      free (tables->text_styles[i].name);
      free (tables->text_styles[i].font_file);
      free (tables->text_styles[i].bigfont_file);
    }
  for (i = 0; i < tables->linetype_count; i++)
    {
      free (tables->linetypes[i].name);
      free (tables->linetypes[i].description);
    }
  free (tables->layers);
  free (tables->layer_indices);
  free (tables->blocks);
  free (tables->block_indices);
  free (tables->text_styles);
  free (tables->text_style_indices);
  free (tables->linetypes);
  free (tables->linetype_codes);
  memset (tables, 0, sizeof (*tables));
}

static int
build_tables (Dwg_Data *dwg, CacheTables *tables)
{
  size_t layer_count = 0;
  size_t block_count = 0;
  size_t text_style_count = 0;
  size_t source_linetype_count = 0;
  size_t linetype_capacity = 0;
  size_t layer_index = 0;
  size_t block_index = 0;
  size_t text_style_index = 0;
  size_t referenced_linetype_count = 0;
  uint32_t next_linetype_code = 3;
  unsigned char *referenced_linetypes = NULL;
  unsigned char *processed_linetypes = NULL;
  size_t i;

  memset (tables, 0, sizeof (*tables));
  tables->model_handle
      = reference_handle (dwg->header_vars.BLOCK_RECORD_MSPACE);
  tables->paper_handle
      = reference_handle (dwg->header_vars.BLOCK_RECORD_PSPACE);

  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      if (dwg->object[i].fixedtype == DWG_TYPE_LAYER)
        layer_count++;
      else if (dwg->object[i].fixedtype == DWG_TYPE_BLOCK_HEADER)
        block_count++;
      else if (dwg->object[i].fixedtype == DWG_TYPE_STYLE)
        text_style_count++;
      else if (dwg->object[i].fixedtype == DWG_TYPE_LTYPE)
        source_linetype_count++;
    }
  if (layer_count > UINT32_MAX || block_count > UINT32_MAX
      || text_style_count > UINT32_MAX)
    return 0;
  if (dwg->num_objects > 0)
    {
      referenced_linetypes
          = (unsigned char *)calloc ((size_t)dwg->num_objects, 1u);
      processed_linetypes
          = (unsigned char *)calloc ((size_t)dwg->num_objects, 1u);
      if (!referenced_linetypes || !processed_linetypes)
        goto table_allocation_failed;
    }
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_LAYER && object->tio.object
          && object->tio.object->tio.LAYER)
        mark_linetype_reference (
            dwg, object->tio.object->tio.LAYER->ltype,
            referenced_linetypes);
      else if (object->supertype == DWG_SUPERTYPE_ENTITY
               && object->tio.entity
               && object->tio.entity->ltype_flags != 0
               && object->tio.entity->ltype_flags != 1
               && object->tio.entity->ltype_flags != 2
               && object->tio.entity->ltype)
        mark_linetype_reference (dwg, object->tio.entity->ltype,
                                 referenced_linetypes);
    }
  mark_linetype_reference (dwg, dwg->header_vars.LTYPE_BYLAYER,
                           referenced_linetypes);
  mark_linetype_reference (dwg, dwg->header_vars.LTYPE_BYBLOCK,
                           referenced_linetypes);
  mark_linetype_reference (dwg, dwg->header_vars.LTYPE_CONTINUOUS,
                           referenced_linetypes);
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    if (dwg->object[i].fixedtype == DWG_TYPE_LTYPE
        && referenced_linetypes && referenced_linetypes[i])
      referenced_linetype_count++;
  linetype_capacity
      = source_linetype_count < MAX_LINETYPE_DEFINITIONS
            ? source_linetype_count
            : MAX_LINETYPE_DEFINITIONS;
  tables->layers
      = layer_count ? (LayerEntry *)calloc (layer_count, sizeof (LayerEntry))
                    : NULL;
  tables->layer_indices
      = layer_count
            ? (HandleIndex *)malloc (layer_count * sizeof (HandleIndex))
            : NULL;
  tables->blocks
      = block_count ? (BlockEntry *)calloc (block_count, sizeof (BlockEntry))
                    : NULL;
  tables->block_indices
      = block_count
            ? (HandleIndex *)malloc (block_count * sizeof (HandleIndex))
            : NULL;
  tables->text_styles
      = text_style_count
            ? (TextStyleEntry *)calloc (text_style_count,
                                       sizeof (TextStyleEntry))
            : NULL;
  tables->text_style_indices
      = text_style_count
            ? (HandleIndex *)malloc (text_style_count * sizeof (HandleIndex))
            : NULL;
  tables->linetypes
      = linetype_capacity
            ? (LinetypeEntry *)calloc (linetype_capacity,
                                      sizeof (LinetypeEntry))
            : NULL;
  tables->linetype_codes
      = source_linetype_count
            ? (HandleIndex *)malloc (source_linetype_count
                                    * sizeof (HandleIndex))
            : NULL;
  if ((layer_count && (!tables->layers || !tables->layer_indices))
      || (block_count && (!tables->blocks || !tables->block_indices))
      || (text_style_count
          && (!tables->text_styles || !tables->text_style_indices))
      || (linetype_capacity && !tables->linetypes)
      || (source_linetype_count && !tables->linetype_codes))
    {
table_allocation_failed:
      free (referenced_linetypes);
      free (processed_linetypes);
      free_tables (tables);
      return 0;
    }
  /*
   * Keep the allocated lengths visible to cleanup while rows are populated.
   * calloc leaves any not-yet-populated string pointers safe to free.
   */
  tables->layer_count = layer_count;
  tables->block_count = block_count;
  tables->text_style_count = text_style_count;
  tables->linetype_count = 0;
  tables->linetype_code_count = 0;
  tables->source_linetype_count = source_linetype_count;
  tables->referenced_linetype_count = referenced_linetype_count;
  tables->omitted_referenced_linetype_count = 0;

  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_LAYER && object->tio.object
          && object->tio.object->tio.LAYER)
        {
          if (layer_index >= layer_count || !tables->layers)
            goto linetype_registration_failed;
          LayerEntry *entry = &tables->layers[layer_index];
          entry->object = object;
          entry->handle = (uint64_t)object->handle.value;
          entry->name
              = copy_utf8_field (dwg->header.codepage,
                                 object->tio.object->tio.LAYER, "LAYER",
                                 "name", "0");
          entry->linetype = copy_linetype_name (
              dwg->header.codepage,
              object->tio.object->tio.LAYER->ltype);
          if (!entry->name || !entry->linetype)
            goto linetype_registration_failed;
          tables->layer_indices[layer_index].handle = entry->handle;
          tables->layer_indices[layer_index].index = (uint32_t)layer_index;
          layer_index++;
        }
      else if (object->fixedtype == DWG_TYPE_BLOCK_HEADER
               && object->tio.object
               && object->tio.object->tio.BLOCK_HEADER)
        {
          if (block_index >= block_count || !tables->blocks)
            goto linetype_registration_failed;
          BlockEntry *entry = &tables->blocks[block_index];
          entry->object = object;
          entry->handle = (uint64_t)object->handle.value;
          entry->name = copy_block_name (
              dwg, object->tio.object->tio.BLOCK_HEADER);
          entry->xref_path
              = copy_utf8_field (dwg->header.codepage,
                                 object->tio.object->tio.BLOCK_HEADER,
                                 "BLOCK_HEADER", "xref_pname", "");
          if (!entry->name || !entry->xref_path)
            goto linetype_registration_failed;
          entry->is_model
              = entry->handle != 0 && entry->handle == tables->model_handle;
          entry->is_paper
              = entry->handle != 0 && entry->handle == tables->paper_handle;
          tables->block_indices[block_index].handle = entry->handle;
          tables->block_indices[block_index].index = (uint32_t)block_index;
          block_index++;
        }
      else if (object->fixedtype == DWG_TYPE_STYLE && object->tio.object
               && object->tio.object->tio.STYLE)
        {
          if (text_style_index >= text_style_count
              || !tables->text_styles)
            goto linetype_registration_failed;
          TextStyleEntry *entry
              = &tables->text_styles[text_style_index];
          Dwg_Object_STYLE *style = object->tio.object->tio.STYLE;
          entry->object = object;
          entry->handle = (uint64_t)object->handle.value;
          entry->name
              = copy_utf8_field (dwg->header.codepage, style, "STYLE",
                                 "name", "");
          entry->font_file
              = copy_utf8_field (dwg->header.codepage, style, "STYLE",
                                 "font_file", "");
          entry->bigfont_file
              = copy_utf8_field (dwg->header.codepage, style, "STYLE",
                                 "bigfont_file", "");
          if (!entry->name || !entry->font_file || !entry->bigfont_file)
            goto linetype_registration_failed;
          tables->text_style_indices[text_style_index].handle = entry->handle;
          tables->text_style_indices[text_style_index].index
              = (uint32_t)text_style_index;
          text_style_index++;
        }
    }
  if (!register_linetype (
          dwg, tables,
          reference_object (dwg, dwg->header_vars.LTYPE_BYLAYER), 1,
          processed_linetypes, &next_linetype_code)
      || !register_linetype (
          dwg, tables,
          reference_object (dwg, dwg->header_vars.LTYPE_BYBLOCK), 1,
          processed_linetypes, &next_linetype_code)
      || !register_linetype (
          dwg, tables,
          reference_object (dwg, dwg->header_vars.LTYPE_CONTINUOUS), 1,
          processed_linetypes, &next_linetype_code))
    goto linetype_registration_failed;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    if (referenced_linetypes && referenced_linetypes[i]
        && !register_linetype (
            dwg, tables, &dwg->object[i], 1, processed_linetypes,
            &next_linetype_code))
      goto linetype_registration_failed;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    if (!register_linetype (
            dwg, tables, &dwg->object[i], 0, processed_linetypes,
            &next_linetype_code))
      goto linetype_registration_failed;
  free (referenced_linetypes);
  free (processed_linetypes);
  tables->layer_count = layer_index;
  tables->block_count = block_index;
  tables->text_style_count = text_style_index;
  qsort (tables->layer_indices, tables->layer_count, sizeof (HandleIndex),
         handle_index_compare);
  qsort (tables->block_indices, tables->block_count, sizeof (HandleIndex),
         handle_index_compare);
  qsort (tables->text_style_indices, tables->text_style_count,
         sizeof (HandleIndex), handle_index_compare);
  qsort (tables->linetype_codes, tables->linetype_code_count,
         sizeof (HandleIndex), handle_index_compare);
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_LAYOUT && object->tio.object
          && object->tio.object->tio.LAYOUT)
        {
          uint32_t index = find_handle_index (
              tables->block_indices, tables->block_count,
              reference_handle (
                  object->tio.object->tio.LAYOUT->block_header));
          if (index < tables->block_count
              && !tables->blocks[index].is_model)
            tables->blocks[index].is_paper = 1;
        }
    }
  return 1;

linetype_registration_failed:
  free (referenced_linetypes);
  free (processed_linetypes);
  free_tables (tables);
  return 0;
}

static uint32_t
encode_color (const Dwg_Color *color)
{
  uint32_t method;
  uint32_t packed;

  if (!color)
    return 0;

  /*
   * LibreDWG's public method enum labels 0xc3 as TRUECOLOR, but its CMC/DXF
   * readers use 0xc2 for direct RGB and 0xc3 for ACI. Entity ENC colors leave
   * method unset, so derive it from their packed value as well.
   *
   * LibreDWG's common-entity path also decodes ENC alpha before RGB,
   * unlike its bit_read_ENC helper and the public HATCH qualification fixture.
   * With both 0x80 and 0x20 present, that fixture therefore exposes packed RGB
   * through alpha_raw. Prefer it only when it carries a valid direct-RGB
   * method and the nominal RGB field does not.
   */
  packed = (uint32_t)color->rgb;
  if ((color->flag & 0xa0u) == 0xa0u
      && (packed >> 24) != 0xc2u
      && ((uint32_t)color->alpha_raw >> 24) == 0xc2u)
    packed = (uint32_t)color->alpha_raw;

  method = (uint32_t)color->method;
  if (!method)
    method = packed >> 24;

  if (method == 0xc2u)
    return (3u << 30) | (packed & 0x00ffffffu);
  /*
   * LibreDWG 0.14 preserves ACI table colours in the low byte of the
   * packed CMC value while leaving color.index at 256. This is especially
   * common for LAYER table records. Decode the packed ACI before treating
   * index 256 as BYLAYER, otherwise nearly every layer becomes the default
   * foreground colour.
   */
  if (method == 0xc3u)
    {
      uint32_t aci = packed & 0xffu;
      if (aci == 0u)
        return 1u << 30;
      return (2u << 30) | aci;
    }
  if (color->index == 256 || method == DWG_COLOR_METHOD_BYLAYER)
    return 0;
  if (color->index == 0 || method == DWG_COLOR_METHOD_BYBLOCK)
    return 1u << 30;
  return (2u << 30) | ((uint32_t)color->index & 0xffu);
}

static uint32_t
encode_transparency (const Dwg_Color *color, int is_layer)
{
  uint32_t type;
  uint32_t alpha;
  uint32_t code;
  if (!color)
    return 0;
  type = (uint32_t)color->alpha_type;
  if (type != 0u && type != 1u && type != 3u)
    type = (uint32_t)color->alpha_raw >> 24;
  if (type == 3u)
    {
      alpha = (uint32_t)color->alpha;
      if (alpha > 255u)
        alpha = 255u;
      code = 3u + (alpha * 60u + 127u) / 255u;
    }
  else if (!is_layer && type == 1u)
    code = 2u;
  else if (!is_layer && type == 0u)
    code = 1u;
  else
    code = 0u;
  return code << 24;
}

static uint32_t
encode_entity_color (const Dwg_Color *color)
{
  return encode_color (color) | encode_transparency (color, 0);
}

static uint32_t
encode_layer_color (const Dwg_Color *color)
{
  return encode_color (color) | encode_transparency (color, 1);
}

static uint64_t
entity_owner_handle (const Dwg_Object_Entity *entity,
                     const CacheTables *tables)
{
  uint64_t handle;
  if (!entity)
    return 0;
  handle = reference_handle (entity->ownerhandle);
  if (handle)
    return handle;
  if (entity->entmode == 2)
    return tables->model_handle;
  if (entity->entmode == 1)
    return tables->paper_handle;
  return 0;
}

static uint32_t
entity_layer_index (const Dwg_Object_Entity *entity,
                    const CacheTables *tables)
{
  return find_handle_index (tables->layer_indices, tables->layer_count,
                            reference_handle (entity ? entity->layer : NULL));
}

static uint16_t
entity_linetype_code (const Dwg_Object_Entity *entity,
                      const CacheTables *tables)
{
  uint32_t code;
  if (!entity)
    return 2;
  if (entity->ltype_flags == 0)
    return 0;
  if (entity->ltype_flags == 1)
    return 1;
  if (entity->ltype_flags == 2)
    return 2;
  code = find_handle_index (
      tables->linetype_codes, tables->linetype_code_count,
      reference_handle (entity->ltype));
  return code <= 2047u ? (uint16_t)code : 2;
}

static int
write_common_flags (CacheWriter *writer, const Dwg_Object *object,
                    const CacheTables *tables, uint16_t additional_flags)
{
  const Dwg_Object_Entity *entity = object->tio.entity;
  int line_weight = entity ? dxf_cvt_lweight (entity->linewt) : -1;
  uint16_t flags
      = (entity && entity->invisible ? 1u : 0u) | additional_flags;
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  return write_u64 (writer, (uint64_t)object->handle.value)
         && write_u64 (writer, entity_owner_handle (entity, tables))
         && write_u32 (writer, entity_layer_index (entity, tables))
         && write_u32 (
             writer,
             encode_entity_color (entity ? &entity->color : NULL))
         && write_i16 (writer, (int16_t)line_weight)
         && write_u16 (writer, flags)
         && write_u32 (writer, entity_linetype_code (entity, tables));
}

static int
write_common (CacheWriter *writer, const Dwg_Object *object,
              const CacheTables *tables)
{
  return write_common_flags (writer, object, tables, 0u);
}

static int
write_common_color (CacheWriter *writer, const Dwg_Object *object,
                    const CacheTables *tables,
                    const Dwg_Color *display_color)
{
  const Dwg_Object_Entity *entity = object->tio.entity;
  int line_weight = entity ? dxf_cvt_lweight (entity->linewt) : -1;
  uint16_t flags = entity && entity->invisible ? 1u : 0u;
  uint32_t color
      = encode_color (
            display_color ? display_color
                          : (entity ? &entity->color : NULL))
        | encode_transparency (entity ? &entity->color : NULL, 0);
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  return write_u64 (writer, (uint64_t)object->handle.value)
         && write_u64 (writer, entity_owner_handle (entity, tables))
         && write_u32 (writer, entity_layer_index (entity, tables))
         && write_u32 (writer, color)
         && write_i16 (writer, (int16_t)line_weight)
         && write_u16 (writer, flags)
         && write_u32 (writer, entity_linetype_code (entity, tables));
}

static int
proxy_read_u16 (const uint8_t *data, size_t size, size_t offset,
                uint16_t *value)
{
  if (!data || !value || offset > size || size - offset < 2u)
    return 0;
  *value = (uint16_t)data[offset]
           | (uint16_t)((uint16_t)data[offset + 1u] << 8u);
  return 1;
}

static int
proxy_read_u32 (const uint8_t *data, size_t size, size_t offset,
                uint32_t *value)
{
  if (!data || !value || offset > size || size - offset < 4u)
    return 0;
  *value = (uint32_t)data[offset]
           | ((uint32_t)data[offset + 1u] << 8u)
           | ((uint32_t)data[offset + 2u] << 16u)
           | ((uint32_t)data[offset + 3u] << 24u);
  return 1;
}

static int
proxy_read_i32 (const uint8_t *data, size_t size, size_t offset,
                int32_t *value)
{
  uint32_t raw;
  if (!proxy_read_u32 (data, size, offset, &raw))
    return 0;
  memcpy (value, &raw, sizeof (raw));
  return 1;
}

static int
proxy_read_u64 (const uint8_t *data, size_t size, size_t offset,
                uint64_t *value)
{
  uint32_t low;
  uint32_t high;
  if (!proxy_read_u32 (data, size, offset, &low)
      || !proxy_read_u32 (data, size, offset + 4u, &high))
    return 0;
  *value = (uint64_t)low | ((uint64_t)high << 32u);
  return 1;
}

static int
proxy_read_f64 (const uint8_t *data, size_t size, size_t offset,
                double *value)
{
  uint64_t bits;
  if (!proxy_read_u64 (data, size, offset, &bits))
    return 0;
  memcpy (value, &bits, sizeof (bits));
  return 1;
}

static int
proxy_align4 (size_t value, size_t *aligned)
{
  if (!aligned || value > SIZE_MAX - 3u)
    return 0;
  *aligned = (value + 3u) & ~(size_t)3u;
  return 1;
}

static int
is_proxy_graphic_source_object (const Dwg_Object *object)
{
  const Dwg_Object_Entity *entity;
  if (!object || (object->fixedtype != DWG_TYPE_UNKNOWN_ENT
                  && object->fixedtype != DWG_TYPE_PROXY_ENTITY)
      || !(entity = object->tio.entity) || !entity->preview_exists
      || !entity->preview || entity->preview_size < 8u
      || entity->preview_size > MAX_PROXY_GRAPHIC_BYTES
      || entity->preview_size > SIZE_MAX)
    return 0;
  return 1;
}

static int
initialize_proxy_graphic_reader (const Dwg_Object *object,
                                 ProxyGraphicReader *reader)
{
  uint32_t declared_size;
  uint32_t expected_chunks;
  size_t size;
  if (!reader || !is_proxy_graphic_source_object (object))
    return 0;
  size = (size_t)object->tio.entity->preview_size;
  memset (reader, 0, sizeof (*reader));
  reader->data = (const uint8_t *)object->tio.entity->preview;
  reader->size = size;
  reader->offset = 8u;
  if (!proxy_read_u32 (reader->data, size, 0u, &declared_size)
      || !proxy_read_u32 (reader->data, size, 4u, &expected_chunks)
      || declared_size != size
      || expected_chunks > MAX_PROXY_GRAPHIC_CHUNKS)
    return 0;
  reader->expected_chunks = expected_chunks;
  return 1;
}

static int
next_proxy_graphic_chunk (ProxyGraphicReader *reader,
                          ProxyGraphicChunk *chunk)
{
  uint32_t chunk_size;
  uint32_t type;
  if (!reader || !chunk)
    return -1;
  if (reader->offset == reader->size)
    return reader->expected_chunks == 0u
                   || reader->chunks == reader->expected_chunks
               ? 0
               : -1;
  if (reader->offset > reader->size
      || reader->size - reader->offset < 8u
      || reader->chunks >= MAX_PROXY_GRAPHIC_CHUNKS
      || !proxy_read_u32 (reader->data, reader->size, reader->offset,
                          &chunk_size)
      || !proxy_read_u32 (reader->data, reader->size,
                          reader->offset + 4u, &type)
      || chunk_size < 8u || (chunk_size & 3u) != 0u
      || (size_t)chunk_size > reader->size - reader->offset)
    return -1;
  chunk->type = type;
  chunk->data = reader->data + reader->offset + 8u;
  chunk->size = (size_t)chunk_size - 8u;
  reader->offset += (size_t)chunk_size;
  reader->chunks++;
  return 1;
}

static uint32_t
proxy_scene_color (uint32_t raw, uint32_t fallback)
{
  uint32_t method = raw >> 24u;
  if (method == 0xc0u)
    return 0u;
  if (method == 0xc1u)
    return 1u << 30u;
  if (method == 0xc2u)
    return (3u << 30u) | (raw & 0x00ffffffu);
  if (method == 0xc3u)
    {
      uint32_t aci = raw & 0xffu;
      return aci == 0u ? (1u << 30u) : (2u << 30u) | aci;
    }
  if (raw <= 256u)
    {
      if (raw == 256u)
        return 0u;
      if (raw == 0u)
        return 1u << 30u;
      return (2u << 30u) | raw;
    }
  return fallback;
}

static void
initialize_proxy_graphic_state (const Dwg_Object *object,
                                const CacheTables *tables,
                                ProxyGraphicState *state)
{
  const Dwg_Object_Entity *entity
      = object && object->tio.entity ? object->tio.entity : NULL;
  int line_weight = entity ? dxf_cvt_lweight (entity->linewt) : -1;
  memset (state, 0, sizeof (*state));
  state->color = encode_entity_color (entity ? &entity->color : NULL);
  state->linetype_code
      = tables ? entity_linetype_code (entity, tables) : 0u;
  state->line_weight
      = line_weight >= INT16_MIN && line_weight <= INT16_MAX
            ? (int16_t)line_weight
            : -1;
}

static int
apply_proxy_graphic_control (ProxyGraphicState *state,
                             const ProxyGraphicChunk *chunk)
{
  uint32_t raw;
  int32_t signed_raw;
  size_t index;
  if (!state || !chunk)
    return -1;
  switch (chunk->type)
    {
    case PROXY_GRAPHIC_PUSH_MATRIX:
    case PROXY_GRAPHIC_PUSH_MATRIX2:
      if (chunk->size < 16u * sizeof (double)
          || state->matrix_depth >= MAX_PROXY_GRAPHIC_MATRIX_DEPTH)
        return -1;
      for (index = 0; index < 16u; index++)
        if (!proxy_read_f64 (
                chunk->data, chunk->size, index * sizeof (double),
                &state->matrices[state->matrix_depth][index])
            || !isfinite (
                state->matrices[state->matrix_depth][index]))
          return -1;
      state->matrix_depth++;
      return 1;
    case PROXY_GRAPHIC_POP_MATRIX:
      if (!state->matrix_depth)
        return -1;
      state->matrix_depth--;
      return 1;
    case PROXY_GRAPHIC_ATTRIBUTE_COLOR:
    case PROXY_GRAPHIC_ATTRIBUTE_TRUE_COLOR:
      if (!proxy_read_u32 (chunk->data, chunk->size, 0u, &raw))
        return -1;
      state->color = proxy_scene_color (raw, state->color);
      return 1;
    case PROXY_GRAPHIC_ATTRIBUTE_LINETYPE:
      if (!proxy_read_u32 (chunk->data, chunk->size, 0u, &raw))
        return -1;
      if (raw == 32766u)
        state->linetype_code = 1u;
      else if (raw == 32767u)
        state->linetype_code = 0u;
      else if (raw == 0u)
        state->linetype_code = 2u;
      return 1;
    case PROXY_GRAPHIC_ATTRIBUTE_LINEWEIGHT:
      if (!proxy_read_i32 (chunk->data, chunk->size, 0u, &signed_raw))
        return -1;
      if (signed_raw >= INT16_MIN && signed_raw <= INT16_MAX)
        state->line_weight = (int16_t)signed_raw;
      return 1;
    default:
      return 0;
    }
}

static void
proxy_transform_point (const ProxyGraphicState *state,
                       const double input[3], double output[3])
{
  const double *matrix;
  if (!state || !state->matrix_depth)
    {
      memcpy (output, input, 3u * sizeof (double));
      return;
    }
  matrix = state->matrices[state->matrix_depth - 1u];
  output[0] = matrix[0] * input[0] + matrix[1] * input[1]
              + matrix[2] * input[2] + matrix[3];
  output[1] = matrix[4] * input[0] + matrix[5] * input[1]
              + matrix[6] * input[2] + matrix[7];
  output[2] = matrix[8] * input[0] + matrix[9] * input[1]
              + matrix[10] * input[2] + matrix[11];
}

static void
proxy_transform_vector (const ProxyGraphicState *state,
                        const double input[3], double output[3])
{
  const double *matrix;
  if (!state || !state->matrix_depth)
    {
      memcpy (output, input, 3u * sizeof (double));
      return;
    }
  matrix = state->matrices[state->matrix_depth - 1u];
  output[0] = matrix[0] * input[0] + matrix[1] * input[1]
              + matrix[2] * input[2];
  output[1] = matrix[4] * input[0] + matrix[5] * input[1]
              + matrix[6] * input[2];
  output[2] = matrix[8] * input[0] + matrix[9] * input[1]
              + matrix[10] * input[2];
}

static int
proxy_polyline_vertex_count (const ProxyGraphicChunk *chunk,
                             uint32_t *vertex_count)
{
  uint32_t count;
  uint64_t required;
  if (!chunk || !vertex_count
      || (chunk->type != PROXY_GRAPHIC_POLYLINE
          && chunk->type != PROXY_GRAPHIC_POLYGON
          && chunk->type != PROXY_GRAPHIC_POLYLINE_WITH_NORMALS)
      || !proxy_read_u32 (chunk->data, chunk->size, 0u, &count)
      || count > MAX_PROXY_GRAPHIC_VERTICES_PER_CHUNK)
    return 0;
  required = 4u + (uint64_t)count * 3u * sizeof (double);
  if (chunk->type == PROXY_GRAPHIC_POLYLINE_WITH_NORMALS)
    required += 3u * sizeof (double);
  if (required > chunk->size)
    return 0;
  *vertex_count = count;
  return 1;
}

static int
proxy_graphic_has_supported_display (const Dwg_Object *object)
{
  ProxyGraphicReader reader;
  ProxyGraphicState state;
  ProxyGraphicChunk chunk;
  int status;
  int found = 0;
  if (!initialize_proxy_graphic_reader (object, &reader))
    return 0;
  initialize_proxy_graphic_state (object, NULL, &state);
  while ((status = next_proxy_graphic_chunk (&reader, &chunk)) > 0)
    {
      int control = apply_proxy_graphic_control (&state, &chunk);
      uint32_t count;
      if (control < 0)
        return 0;
      if (control > 0)
        continue;
      if (chunk.type == PROXY_GRAPHIC_UNICODE_TEXT2)
        found = 1;
      else if (proxy_polyline_vertex_count (&chunk, &count)
               && count >= 2u)
        found = 1;
    }
  return status == 0 && found;
}

static void
finite_normal_or_unit_z (double x, double y, double z, double normal[3])
{
  double length_squared = x * x + y * y + z * z;
  if (isfinite (x) && isfinite (y) && isfinite (z)
      && isfinite (length_squared) && length_squared > 1.0e-24)
    {
      normal[0] = x;
      normal[1] = y;
      normal[2] = z;
    }
  else
    {
      normal[0] = 0.0;
      normal[1] = 0.0;
      normal[2] = 1.0;
    }
}

static int
read_polyline_info (const Dwg_Object *object, PolylineInfo *info)
{
  memset (info, 0, sizeof (*info));
  if (!object || !object->tio.entity)
    return 0;
  if (object->fixedtype == DWG_TYPE_LWPOLYLINE
      && object->tio.entity->tio.LWPOLYLINE)
    {
      const Dwg_Entity_LWPOLYLINE *polyline
          = object->tio.entity->tio.LWPOLYLINE;
      info->kind = 1;
      info->closed = (polyline->flag & 512u) != 0;
      info->flags = (uint16_t)(info->closed ? 1u : 0u);
      if (polyline->flag & 256u)
        info->flags |= 1u << 7;
      info->elevation = polyline->elevation;
      info->thickness = polyline->thickness;
      finite_normal_or_unit_z (polyline->extrusion.x,
                               polyline->extrusion.y,
                               polyline->extrusion.z, info->normal);
      info->constant_width = polyline->const_width;
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_POLYLINE_2D
      && object->tio.entity->tio.POLYLINE_2D)
    {
      const Dwg_Entity_POLYLINE_2D *polyline
          = object->tio.entity->tio.POLYLINE_2D;
      info->kind = 2;
      info->flags = (uint16_t)polyline->flag;
      info->closed = (polyline->flag & 1u) != 0;
      info->elevation = polyline->elevation;
      info->thickness = polyline->thickness;
      finite_normal_or_unit_z (polyline->extrusion.x,
                               polyline->extrusion.y,
                               polyline->extrusion.z, info->normal);
      info->default_start_width = polyline->start_width;
      info->default_end_width = polyline->end_width;
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_POLYLINE_3D
      && object->tio.entity->tio.POLYLINE_3D)
    {
      const Dwg_Entity_POLYLINE_3D *polyline
          = object->tio.entity->tio.POLYLINE_3D;
      info->kind = 3;
      info->flags = (uint16_t)polyline->flag;
      info->closed = (polyline->flag & 1u) != 0;
      info->normal[2] = 1.0;
      return 1;
    }
  return 0;
}

static int
consume_polyline_subentity (const Dwg_Object *vertex_object, uint16_t kind,
                            PolylineVertexConsumer consumer, void *context,
                            uint64_t *count)
{
  PolylineVertex vertex;
  memset (&vertex, 0, sizeof (vertex));
  if (!vertex_object || !vertex_object->tio.entity)
    return 1;
  if (kind == 2 && vertex_object->fixedtype == DWG_TYPE_VERTEX_2D
      && vertex_object->tio.entity->tio.VERTEX_2D)
    {
      const Dwg_Entity_VERTEX_2D *source
          = vertex_object->tio.entity->tio.VERTEX_2D;
      vertex.position[0] = source->point.x;
      vertex.position[1] = source->point.y;
      vertex.position[2] = source->point.z;
      vertex.bulge = source->bulge;
      vertex.start_width = source->start_width;
      vertex.end_width = source->end_width;
      vertex.curve_tangent = source->tangent_dir;
      vertex.flags = (uint32_t)source->flag;
      vertex.id = (int32_t)(uint32_t)source->id;
    }
  else if (kind == 3 && vertex_object->fixedtype == DWG_TYPE_VERTEX_3D
           && vertex_object->tio.entity->tio.VERTEX_3D)
    {
      const Dwg_Entity_VERTEX_3D *source
          = vertex_object->tio.entity->tio.VERTEX_3D;
      vertex.position[0] = source->point.x;
      vertex.position[1] = source->point.y;
      vertex.position[2] = source->point.z;
      vertex.flags = (uint32_t)source->flag;
    }
  else
    return 1;
  if (consumer && !consumer (context, &vertex))
    return 0;
  (*count)++;
  return 1;
}

static int
iterate_polyline_vertices (const Dwg_Object *object,
                           PolylineVertexConsumer consumer, void *context,
                           uint64_t *vertex_count)
{
  PolylineInfo info;
  uint64_t count = 0;
  if (!read_polyline_info (object, &info))
    {
      if (vertex_count)
        *vertex_count = 0;
      return 1;
    }
  if (info.kind == 1)
    {
      const Dwg_Entity_LWPOLYLINE *polyline
          = object->tio.entity->tio.LWPOLYLINE;
      uint64_t i;
      if (polyline->num_points && !polyline->points)
        {
          if (vertex_count)
            *vertex_count = 0;
          return 1;
        }
      for (i = 0; i < (uint64_t)polyline->num_points; i++)
        {
          PolylineVertex vertex;
          memset (&vertex, 0, sizeof (vertex));
          vertex.position[0] = polyline->points[i].x;
          vertex.position[1] = polyline->points[i].y;
          vertex.position[2] = polyline->elevation;
          if (polyline->bulges && i < (uint64_t)polyline->num_bulges)
            vertex.bulge = polyline->bulges[i];
          if (polyline->widths && i < (uint64_t)polyline->num_widths)
            {
              vertex.start_width = polyline->widths[i].start;
              vertex.end_width = polyline->widths[i].end;
            }
          if (polyline->vertexids
              && i < (uint64_t)polyline->num_vertexids)
            vertex.id = (int32_t)(uint32_t)polyline->vertexids[i];
          if (consumer && !consumer (context, &vertex))
            return 0;
          count++;
        }
    }
  else
    {
      Dwg_Data *dwg = object->parent;
      BITCODE_H *references = NULL;
      BITCODE_H first = NULL;
      BITCODE_H last = NULL;
      uint64_t declared = 0;
      Dwg_Version_Type version;
      if (!dwg)
        {
          if (vertex_count)
            *vertex_count = 0;
          return 1;
        }
      version = dwg->header.version;
      if (info.kind == 2)
        {
          const Dwg_Entity_POLYLINE_2D *polyline
              = object->tio.entity->tio.POLYLINE_2D;
          declared = (uint64_t)polyline->num_owned;
          references = polyline->vertex;
          first = polyline->first_vertex;
          last = polyline->last_vertex;
        }
      else
        {
          const Dwg_Entity_POLYLINE_3D *polyline
              = object->tio.entity->tio.POLYLINE_3D;
          declared = (uint64_t)polyline->num_owned;
          references = polyline->vertex;
          first = polyline->first_vertex;
          last = polyline->last_vertex;
        }
      if (version < R_13b1)
        {
          Dwg_Object *current = dwg_next_object (object);
          uint64_t visited = 0;
          uint64_t limit = (uint64_t)dwg->num_objects;
          Dwg_Object_Type expected_type
              = info.kind == 2 ? DWG_TYPE_VERTEX_2D
                               : DWG_TYPE_VERTEX_3D;
          while (current && visited < limit
                 && current->fixedtype != DWG_TYPE_SEQEND)
            {
              Dwg_Object *next;
              if (current->fixedtype != expected_type)
                break;
              visited++;
              if (!consume_polyline_subentity (
                      current, info.kind, consumer, context, &count))
                return 0;
              next = dwg_next_object (current);
              current = next;
            }
        }
      else if (version <= R_2000)
        {
          Dwg_Object *current
              = first ? reference_object (dwg, first) : NULL;
          uint64_t visited = 0;
          uint64_t limit = (uint64_t)dwg->num_objects;
          while (current && visited < limit)
            {
              Dwg_Object *next;
              visited++;
              if (!consume_polyline_subentity (
                      current, info.kind, consumer, context, &count))
                return 0;
              if (last && current == last->obj)
                break;
              next = dwg_next_object (current);
              if (!next || next->fixedtype == DWG_TYPE_SEQEND)
                break;
              current = next;
            }
        }
      else if (references)
        {
          uint64_t i;
          uint64_t limit
              = declared < (uint64_t)dwg->num_objects
                    ? declared
                    : (uint64_t)dwg->num_objects;
          for (i = 0; i < limit; i++)
            {
              Dwg_Object *current
                  = references[i]
                        ? reference_object (dwg, references[i])
                        : NULL;
              if (!consume_polyline_subentity (
                      current, info.kind, consumer, context, &count))
                return 0;
            }
        }
    }
  if (vertex_count)
    *vertex_count = count;
  return 1;
}

static uint64_t
polyline_vertex_count (const Dwg_Object *object)
{
  uint64_t count = 0;
  (void)iterate_polyline_vertices (object, NULL, NULL, &count);
  return count;
}

static size_t
spline_knot_count (const Dwg_Entity_SPLINE *spline)
{
  if (!spline || !spline->knots || spline->num_knots <= 0)
    return 0;
  return (size_t)spline->num_knots;
}

static size_t
spline_control_point_count (const Dwg_Entity_SPLINE *spline)
{
  if (!spline || !spline->ctrl_pts || spline->num_ctrl_pts <= 0)
    return 0;
  return (size_t)spline->num_ctrl_pts;
}

static size_t
spline_weight_count (const Dwg_Entity_SPLINE *spline)
{
  return spline && spline->weighted
             ? spline_control_point_count (spline)
             : 0;
}

static size_t
spline_fit_point_count (const Dwg_Entity_SPLINE *spline)
{
  if (!spline || !spline->fit_pts || spline->num_fit_pts <= 0)
    return 0;
  return (size_t)spline->num_fit_pts;
}

static int
spline_is_closed (const Dwg_Entity_SPLINE *spline)
{
  return spline
         && (spline->closed_b || (spline->splineflags & 4u) != 0);
}

static int
is_logical_entity (const Dwg_Object *object)
{
  if (object->supertype != DWG_SUPERTYPE_ENTITY)
    return 0;
  switch (object->fixedtype)
    {
    case DWG_TYPE_BLOCK:
    case DWG_TYPE_ENDBLK:
    case DWG_TYPE_SEQEND:
    case DWG_TYPE_VERTEX_2D:
    case DWG_TYPE_VERTEX_3D:
    case DWG_TYPE_VERTEX_MESH:
    case DWG_TYPE_VERTEX_PFACE:
    case DWG_TYPE_VERTEX_PFACE_FACE:
    case DWG_TYPE_ATTRIB:
      return 0;
    default:
      return 1;
    }
}

static int
mleader_has_serializable_content (const Dwg_Object *object)
{
  const Dwg_Entity_MULTILEADER *mleader;
  size_t leader_index;
  if (!object || object->fixedtype != DWG_TYPE_MULTILEADER
      || !object->tio.entity
      || !(mleader = object->tio.entity->tio.MULTILEADER))
    return 0;
  if (mleader->ctx.has_content_txt || mleader->ctx.has_content_blk)
    return 1;
  if (!mleader->ctx.leaders || mleader->ctx.num_leaders <= 0)
    return 0;
  for (leader_index = 0;
       leader_index < (size_t)mleader->ctx.num_leaders;
       leader_index++)
    {
      const Dwg_LEADER_Node *node
          = &mleader->ctx.leaders[leader_index];
      if ((node->lines && node->num_lines > 0)
          || node->has_lastleaderlinepoint || node->has_dogleg)
        return 1;
    }
  return 0;
}

static const Dwg_DIMENSION_common *
dimension_common (const Dwg_Object *object)
{
  if (!object || !object->tio.entity)
    return NULL;
  switch (object->fixedtype)
    {
    case DWG_TYPE_DIMENSION_LINEAR:
    case DWG_TYPE_DIMENSION_ALIGNED:
    case DWG_TYPE_DIMENSION_ANG2LN:
    case DWG_TYPE_DIMENSION_ANG3PT:
    case DWG_TYPE_DIMENSION_RADIUS:
    case DWG_TYPE_DIMENSION_DIAMETER:
    case DWG_TYPE_DIMENSION_ORDINATE:
    case DWG_TYPE_ARC_DIMENSION:
    case DWG_TYPE_LARGE_RADIAL_DIMENSION:
      return object->tio.entity->tio.DIMENSION_common;
    default:
      return NULL;
    }
}

static int
dimension_block_target (const Dwg_Object *object,
                        const CacheTables *tables, uint64_t *target_handle,
                        double base_point[3])
{
  const Dwg_DIMENSION_common *dimension = dimension_common (object);
  uint64_t handle;
  uint32_t block_index;
  Dwg_Object_BLOCK_HEADER *block;
  if (!dimension)
    return 0;
  handle = reference_handle (dimension->block);
  block_index = find_handle_index (tables->block_indices,
                                   tables->block_count, handle);
  if (block_index == UINT32_MAX || block_index >= tables->block_count
      || !tables->blocks[block_index].object
      || !tables->blocks[block_index].object->tio.object
      || !(block = tables->blocks[block_index]
                       .object->tio.object->tio.BLOCK_HEADER))
    return 0;
  base_point[0] = block->base_pt.x;
  base_point[1] = block->base_pt.y;
  base_point[2] = block->base_pt.z;
  if (!isfinite (base_point[0]) || !isfinite (base_point[1])
      || !isfinite (base_point[2]))
    return 0;
  *target_handle = handle;
  return 1;
}

static int
logical_entity_has_serialized_representation (
    const Dwg_Object *object, const CacheTables *tables)
{
  if (!object || !is_logical_entity (object))
    return 0;
  switch (object->fixedtype)
    {
    case DWG_TYPE_LINE:
    case DWG_TYPE_ARC:
    case DWG_TYPE_CIRCLE:
    case DWG_TYPE_INSERT:
    case DWG_TYPE_MINSERT:
    case DWG_TYPE_LWPOLYLINE:
    case DWG_TYPE_POLYLINE_2D:
    case DWG_TYPE_POLYLINE_3D:
    case DWG_TYPE_ELLIPSE:
    case DWG_TYPE_TEXT:
    case DWG_TYPE_MTEXT:
    case DWG_TYPE_ATTDEF:
      return 1;
    case DWG_TYPE_SPLINE:
      return object->tio.entity && object->tio.entity->tio.SPLINE;
    case DWG_TYPE_HATCH:
      return object->tio.entity && object->tio.entity->tio.HATCH;
    case DWG_TYPE_POINT:
      return object->tio.entity && object->tio.entity->tio.POINT;
    case DWG_TYPE_SOLID:
      return object->tio.entity && object->tio.entity->tio.SOLID;
    case DWG_TYPE_TRACE:
      return object->tio.entity && object->tio.entity->tio.TRACE;
    case DWG_TYPE_REGION:
      return object->tio.entity && object->tio.entity->tio.REGION;
    case DWG_TYPE__3DSOLID:
      return object->tio.entity && object->tio.entity->tio._3DSOLID;
    case DWG_TYPE_BODY:
      return object->tio.entity && object->tio.entity->tio.BODY;
    case DWG_TYPE__3DFACE:
      return object->tio.entity && object->tio.entity->tio._3DFACE;
    case DWG_TYPE_WIPEOUT:
      return object->tio.entity && object->tio.entity->tio.WIPEOUT;
    case DWG_TYPE_IMAGE:
      return object->tio.entity && object->tio.entity->tio.IMAGE;
    case DWG_TYPE_XLINE:
      return object->tio.entity && object->tio.entity->tio.XLINE;
    case DWG_TYPE_RAY:
      return object->tio.entity && object->tio.entity->tio.RAY;
    case DWG_TYPE_POLYLINE_MESH:
      return object->tio.entity
             && object->tio.entity->tio.POLYLINE_MESH;
    case DWG_TYPE_MLINE:
      return object->tio.entity && object->tio.entity->tio.MLINE;
    case DWG_TYPE_MULTILEADER:
      return mleader_has_serializable_content (object);
    case DWG_TYPE_LEADER:
      return object->tio.entity && object->tio.entity->tio.LEADER;
    case DWG_TYPE_OLE2FRAME:
      return object->tio.entity && object->tio.entity->tio.OLE2FRAME;
    case DWG_TYPE_VIEWPORT:
      return is_viewport_entity (object);
    case DWG_TYPE_UNKNOWN_ENT:
    case DWG_TYPE_PROXY_ENTITY:
      return proxy_graphic_has_supported_display (object);
    case DWG_TYPE_DIMENSION_LINEAR:
    case DWG_TYPE_DIMENSION_ALIGNED:
    case DWG_TYPE_DIMENSION_ANG2LN:
    case DWG_TYPE_DIMENSION_ANG3PT:
    case DWG_TYPE_DIMENSION_RADIUS:
    case DWG_TYPE_DIMENSION_DIAMETER:
    case DWG_TYPE_DIMENSION_ORDINATE:
    case DWG_TYPE_ARC_DIMENSION:
    case DWG_TYPE_LARGE_RADIAL_DIMENSION:
      {
        uint64_t target_handle;
        double base_point[3];
        return dimension_block_target (
            object, tables, &target_handle, base_point);
      }
    default:
      return 0;
    }
}

static int
is_supported_logical_entity_type (Dwg_Object_Type type)
{
  switch (type)
    {
    case DWG_TYPE_LINE:
    case DWG_TYPE_ARC:
    case DWG_TYPE_CIRCLE:
    case DWG_TYPE_INSERT:
    case DWG_TYPE_MINSERT:
    case DWG_TYPE_LWPOLYLINE:
    case DWG_TYPE_POLYLINE_2D:
    case DWG_TYPE_POLYLINE_3D:
    case DWG_TYPE_ELLIPSE:
    case DWG_TYPE_SPLINE:
    case DWG_TYPE_TEXT:
    case DWG_TYPE_MTEXT:
    case DWG_TYPE_ATTDEF:
    case DWG_TYPE_HATCH:
    case DWG_TYPE_POINT:
    case DWG_TYPE_SOLID:
    case DWG_TYPE_TRACE:
    case DWG_TYPE_REGION:
    case DWG_TYPE__3DSOLID:
    case DWG_TYPE_BODY:
    case DWG_TYPE__3DFACE:
    case DWG_TYPE_WIPEOUT:
    case DWG_TYPE_IMAGE:
    case DWG_TYPE_XLINE:
    case DWG_TYPE_RAY:
    case DWG_TYPE_POLYLINE_MESH:
    case DWG_TYPE_MLINE:
    case DWG_TYPE_MULTILEADER:
    case DWG_TYPE_LEADER:
    case DWG_TYPE_OLE2FRAME:
    case DWG_TYPE_VIEWPORT:
      return 1;
    default:
      return 0;
    }
}

static int
is_dimension_entity_type (Dwg_Object_Type type)
{
  switch (type)
    {
    case DWG_TYPE_DIMENSION_LINEAR:
    case DWG_TYPE_DIMENSION_ALIGNED:
    case DWG_TYPE_DIMENSION_ANG2LN:
    case DWG_TYPE_DIMENSION_ANG3PT:
    case DWG_TYPE_DIMENSION_RADIUS:
    case DWG_TYPE_DIMENSION_DIAMETER:
    case DWG_TYPE_DIMENSION_ORDINATE:
    case DWG_TYPE_ARC_DIMENSION:
    case DWG_TYPE_LARGE_RADIAL_DIMENSION:
      return 1;
    default:
      return 0;
    }
}

static int
is_unsupported_3d_entity_type (Dwg_Object_Type type)
{
  switch (type)
    {
    case DWG_TYPE_HELIX:
    case DWG_TYPE_MESH:
    case DWG_TYPE_EXTRUDEDSURFACE:
    case DWG_TYPE_LOFTEDSURFACE:
    case DWG_TYPE_NURBSURFACE:
    case DWG_TYPE_PLANESURFACE:
    case DWG_TYPE_REVOLVEDSURFACE:
    case DWG_TYPE_SWEPTSURFACE:
    case DWG_TYPE_LIGHT:
    case DWG_TYPE_SECTIONOBJECT:
    case DWG_TYPE_POINTCLOUD:
    case DWG_TYPE_POINTCLOUDEX:
    case DWG_TYPE_NAVISWORKSMODEL:
      return 1;
    default:
      return 0;
    }
}

static LibreDwgPrimitiveCounts
count_primitives (const Dwg_Data *dwg, const CacheTables *tables)
{
  LibreDwgPrimitiveCounts counts;
  size_t i;
  memset (&counts, 0, sizeof (counts));
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (!is_logical_entity (object))
        continue;
      counts.total_entities++;
      switch (object->fixedtype)
        {
        case DWG_TYPE_LINE:
          counts.lines++;
          break;
        case DWG_TYPE_ARC:
          counts.arcs++;
          break;
        case DWG_TYPE_CIRCLE:
          counts.circles++;
          break;
        case DWG_TYPE_INSERT:
        case DWG_TYPE_MINSERT:
          counts.inserts++;
          break;
        case DWG_TYPE_LWPOLYLINE:
          counts.lwpolylines++;
          counts.polyline_vertices
              += polyline_vertex_count (object);
          break;
        case DWG_TYPE_POLYLINE_2D:
          counts.polylines_2d++;
          counts.polyline_vertices
              += polyline_vertex_count (object);
          break;
        case DWG_TYPE_POLYLINE_3D:
          counts.polylines_3d++;
          counts.polyline_vertices
              += polyline_vertex_count (object);
          break;
        case DWG_TYPE_ELLIPSE:
          counts.ellipses++;
          break;
        case DWG_TYPE_SPLINE:
          if (object->tio.entity
              && object->tio.entity->tio.SPLINE)
            {
              const Dwg_Entity_SPLINE *spline
                  = object->tio.entity->tio.SPLINE;
              counts.splines++;
              counts.spline_knots += spline_knot_count (spline);
              counts.spline_weights += spline_weight_count (spline);
              counts.spline_control_points
                  += spline_control_point_count (spline);
              counts.spline_fit_points
                  += spline_fit_point_count (spline);
            }
          break;
        case DWG_TYPE_TEXT:
          counts.texts++;
          break;
        case DWG_TYPE_MTEXT:
          counts.mtexts++;
          break;
        case DWG_TYPE_ATTDEF:
          counts.attribute_definitions++;
          break;
        case DWG_TYPE_HATCH:
          if (object->tio.entity
              && object->tio.entity->tio.HATCH)
            counts.hatches++;
          break;
        case DWG_TYPE_POINT:
          if (object->tio.entity && object->tio.entity->tio.POINT)
            counts.points++;
          break;
        case DWG_TYPE_SOLID:
          if (object->tio.entity && object->tio.entity->tio.SOLID)
            counts.solids++;
          break;
        case DWG_TYPE_TRACE:
          if (object->tio.entity && object->tio.entity->tio.TRACE)
            counts.traces++;
          break;
        case DWG_TYPE_REGION:
          if (object->tio.entity && object->tio.entity->tio.REGION)
            counts.regions++;
          break;
        case DWG_TYPE__3DSOLID:
          if (object->tio.entity && object->tio.entity->tio._3DSOLID)
            counts.solids_3d++;
          break;
        case DWG_TYPE_BODY:
          if (object->tio.entity && object->tio.entity->tio.BODY)
            counts.bodies++;
          break;
        case DWG_TYPE__3DFACE:
          if (object->tio.entity && object->tio.entity->tio._3DFACE)
            counts.faces++;
          break;
        case DWG_TYPE_WIPEOUT:
          if (object->tio.entity && object->tio.entity->tio.WIPEOUT)
            counts.wipeouts++;
          break;
        case DWG_TYPE_IMAGE:
          if (object->tio.entity && object->tio.entity->tio.IMAGE)
            counts.images++;
          break;
        case DWG_TYPE_XLINE:
          if (object->tio.entity && object->tio.entity->tio.XLINE)
            counts.xlines++;
          break;
        case DWG_TYPE_RAY:
          if (object->tio.entity && object->tio.entity->tio.RAY)
            counts.rays++;
          break;
        case DWG_TYPE_POLYLINE_MESH:
          if (object->tio.entity
              && object->tio.entity->tio.POLYLINE_MESH)
            counts.polyline_meshes++;
          break;
        case DWG_TYPE_MLINE:
          if (object->tio.entity && object->tio.entity->tio.MLINE)
            counts.mlines++;
          break;
        case DWG_TYPE_MULTILEADER:
          if (mleader_has_serializable_content (object))
            counts.multileaders++;
          break;
        case DWG_TYPE_LEADER:
          if (object->tio.entity && object->tio.entity->tio.LEADER)
            counts.leaders++;
          break;
        case DWG_TYPE_OLE2FRAME:
          if (object->tio.entity && object->tio.entity->tio.OLE2FRAME)
            counts.ole2frames++;
          break;
        case DWG_TYPE_VIEWPORT:
          /*
           * VIEWPORT records are preserved as layout metadata even when the
           * paper-space viewport itself has no visible rectangular frame
           * (the primary paper viewport and non-rectangular clips).
          */
          if (is_viewport_entity (object))
            counts.viewports++;
          break;
        case DWG_TYPE_UNKNOWN_ENT:
        case DWG_TYPE_PROXY_ENTITY:
          if (proxy_graphic_has_supported_display (object))
            counts.proxy_graphics++;
          break;
        case DWG_TYPE_DIMENSION_LINEAR:
        case DWG_TYPE_DIMENSION_ALIGNED:
        case DWG_TYPE_DIMENSION_ANG2LN:
        case DWG_TYPE_DIMENSION_ANG3PT:
        case DWG_TYPE_DIMENSION_RADIUS:
        case DWG_TYPE_DIMENSION_DIAMETER:
        case DWG_TYPE_DIMENSION_ORDINATE:
        case DWG_TYPE_ARC_DIMENSION:
        case DWG_TYPE_LARGE_RADIAL_DIMENSION:
          {
            uint64_t target_handle;
            double base_point[3];
            if (dimension_block_target (object, tables, &target_handle,
                                        base_point))
              counts.dimensions++;
          }
          break;
        default:
          break;
        }
    }
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_ATTRIB && object->tio.entity
          && object->tio.entity->tio.ATTRIB)
        counts.attributes++;
    }
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (!is_logical_entity (object))
        continue;
      if (logical_entity_has_serialized_representation (object, tables))
        {
          counts.serialized_entities++;
          continue;
        }
      if (is_dimension_entity_type (object->fixedtype))
        counts.unresolved_dimensions++;
      else if (object->fixedtype == DWG_TYPE_PDFUNDERLAY
               || object->fixedtype == DWG_TYPE_DWFUNDERLAY
               || object->fixedtype == DWG_TYPE_DGNUNDERLAY)
        counts.unsupported_underlays++;
      else if (object->fixedtype == DWG_TYPE_UNKNOWN_ENT
               || object->fixedtype == DWG_TYPE_PROXY_ENTITY)
        counts.unsupported_proxy_graphics++;
      else if (is_unsupported_3d_entity_type (object->fixedtype))
        counts.unsupported_3d_entities++;
      else if (is_supported_logical_entity_type (object->fixedtype))
        counts.invalid_supported_entities++;
      else
        counts.unsupported_other_entities++;
    }
  counts.deferred_entities
      = counts.total_entities - counts.serialized_entities;
  return counts;
}

static int
read_drawing_wipeout_frame (CacheWriter *writer, const Dwg_Data *dwg,
                            uint32_t *result)
{
  uint32_t setting = UINT32_MAX;
  size_t object_index;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_WIPEOUTVARIABLES *variables;
      uint32_t raw;
      if (object->fixedtype != DWG_TYPE_WIPEOUTVARIABLES
          || !object->tio.object
          || !(variables = object->tio.object->tio.WIPEOUTVARIABLES))
        continue;
      raw = (uint32_t)variables->display_frame;
      if (raw > 2u)
        {
          set_error (
              writer,
              "WIPEOUT frame setting is outside the supported range");
          return 0;
        }
      if (setting != UINT32_MAX && setting != raw)
        {
          set_error (
              writer,
              "drawing contains conflicting WIPEOUT frame settings");
          return 0;
        }
      setting = raw;
    }
  *result = setting;
  return 1;
}

static int
read_dictionary_display_setting (CacheWriter *writer, Dwg_Data *dwg,
                                 const char *name, uint32_t maximum,
                                 uint32_t *result)
{
  char *value = copy_variable_dictionary_value (dwg, name);
  char *end;
  long parsed;
  if (!value || !value[0])
    {
      free (value);
      *result = UINT32_MAX;
      return 1;
    }
  errno = 0;
  parsed = strtol (value, &end, 10);
  while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n')
    end++;
  if (errno || end == value || *end || parsed < 0
      || (unsigned long)parsed > maximum)
    {
      char message[160];
      (void)snprintf (message, sizeof (message),
                      "%s setting is outside the supported range", name);
      set_error (writer, message);
      free (value);
      return 0;
    }
  *result = (uint32_t)parsed;
  free (value);
  return 1;
}

static int
read_drawing_presentation_settings (CacheWriter *writer, Dwg_Data *dwg,
                                    uint32_t *result)
{
  uint32_t attribute_mode = (uint32_t)dwg->header_vars.ATTMODE;
  uint32_t quick_text_mode = (uint32_t)dwg->header_vars.QTEXTMODE;
  uint32_t spline_frame = (uint32_t)dwg->header_vars.SPLFRAME;
  uint32_t display_silhouettes = (uint32_t)dwg->header_vars.DISPSILH;
  uint32_t retain_external_reference_layers
      = (uint32_t)dwg->header_vars.VISRETAIN;
  uint32_t image_frame = UINT32_MAX;
  uint32_t raster_image_quality = UINT32_MAX;
  uint32_t xclip_frame = (uint32_t)dwg->header_vars.XCLIPFRAME;
  uint32_t ole_frame;
  uint32_t annotation_all_visible;
  uint32_t model_space_linetype_scale;
  uint32_t frame;
  uint32_t pdf_frame;
  uint32_t dwf_frame;
  uint32_t dgn_frame;
  uint32_t xref_override;
  uint32_t display_silhouettes_in_blocks;
  uint32_t packed;
  size_t object_index;
  if (attribute_mode > 2u)
    {
      set_error (writer, "ATTMODE setting is outside the supported range");
      return 0;
    }
  if (quick_text_mode > 1u || spline_frame > 1u
      || display_silhouettes > 1u
      || retain_external_reference_layers > 1u)
    {
      set_error (writer,
                 "boolean drawing presentation setting is outside the supported range");
      return 0;
    }
  if (xclip_frame > 2u)
    {
      set_error (writer,
                 "XCLIPFRAME setting is outside the supported range");
      return 0;
    }
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_RASTERVARIABLES *variables;
      uint32_t raw;
      if (object->fixedtype != DWG_TYPE_RASTERVARIABLES
          || !object->tio.object
          || !(variables = object->tio.object->tio.RASTERVARIABLES))
        continue;
      raw = (uint32_t)variables->image_frame;
      if (raw > 2u)
        {
          set_error (writer,
                     "IMAGEFRAME setting is outside the supported range");
          return 0;
        }
      if (image_frame != UINT32_MAX && image_frame != raw)
        {
          set_error (writer,
                     "drawing contains conflicting IMAGEFRAME settings");
          return 0;
        }
      image_frame = raw;
      raw = (uint32_t)variables->image_quality;
      if (raw > 1u)
        {
          set_error (writer,
                     "IMAGEQUALITY setting is outside the supported range");
          return 0;
        }
      if (raster_image_quality != UINT32_MAX
          && raster_image_quality != raw)
        {
          set_error (writer,
                     "drawing contains conflicting IMAGEQUALITY settings");
          return 0;
        }
      raster_image_quality = raw;
    }
  if (!read_dictionary_display_setting (
          writer, dwg, "OLEFRAME", 2u, &ole_frame)
      || !read_dictionary_display_setting (
          writer, dwg, "ANNOALLVISIBLE", 1u,
          &annotation_all_visible)
      || !read_dictionary_display_setting (
          writer, dwg, "MSLTSCALE", 1u,
          &model_space_linetype_scale)
      || !read_dictionary_display_setting (
          writer, dwg, "FRAME", 3u, &frame)
      || !read_dictionary_display_setting (
          writer, dwg, "PDFFRAME", 2u, &pdf_frame)
      || !read_dictionary_display_setting (
          writer, dwg, "DWFFRAME", 2u, &dwf_frame)
      || !read_dictionary_display_setting (
          writer, dwg, "DGNFRAME", 2u, &dgn_frame)
      || !read_dictionary_display_setting (
          writer, dwg, "XREFOVERRIDE", 1u, &xref_override)
      || !read_dictionary_display_setting (
          writer, dwg, "DISPSILHBLOCKS", 1u,
          &display_silhouettes_in_blocks))
    return 0;
  packed = attribute_mode
           | ((image_frame == UINT32_MAX ? 3u : image_frame) << 2)
           | (xclip_frame << 4)
           | ((ole_frame == UINT32_MAX ? 3u : ole_frame) << 6)
           | ((annotation_all_visible == UINT32_MAX
                   ? 3u
                   : annotation_all_visible)
              << 8)
           | ((model_space_linetype_scale == UINT32_MAX
                   ? 3u
                   : model_space_linetype_scale)
              << 10);
  if (frame != UINT32_MAX)
    packed |= (frame << 12) | (1u << 14);
  packed |= ((pdf_frame == UINT32_MAX ? 3u : pdf_frame) << 15)
            | ((dwf_frame == UINT32_MAX ? 3u : dwf_frame) << 17)
            | ((dgn_frame == UINT32_MAX ? 3u : dgn_frame) << 19);
  if (quick_text_mode)
    packed |= 1u << 21;
  if (spline_frame)
    packed |= 1u << 22;
  if (display_silhouettes)
    packed |= 1u << 23;
  if (xref_override != UINT32_MAX && xref_override)
    packed |= 1u << 24;
  if (retain_external_reference_layers)
    packed |= 1u << 25;
  if (raster_image_quality == UINT32_MAX || raster_image_quality)
    packed |= 1u << 26;
  if (display_silhouettes_in_blocks == UINT32_MAX
      || display_silhouettes_in_blocks)
    packed |= 1u << 27;
  *result = packed;
  return 1;
}

static void
read_saved_model_view (const Dwg_Data *dwg, SavedModelView *result)
{
  size_t object_index;
  memset (result, 0, sizeof (*result));
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_VPORT *viewport;
      char *name;
      double direction_scale;
      double cosine;
      double sine;
      if (object->fixedtype != DWG_TYPE_VPORT || !object->tio.object
          || !(viewport = object->tio.object->tio.VPORT))
        continue;
      name = copy_utf8_field (
          dwg->header.codepage, (void *)viewport, "VPORT", "name", "");
      if (!name)
        continue;
      if (strcmp (name, "*Active") != 0)
        {
          free (name);
          continue;
        }
      free (name);
      direction_scale
          = fmax (fabs (viewport->VIEWDIR.x),
                  fmax (fabs (viewport->VIEWDIR.y),
                        fabs (viewport->VIEWDIR.z)));
      if (!isfinite (viewport->VIEWCTR.x)
          || !isfinite (viewport->VIEWCTR.y)
          || !isfinite (viewport->view_target.x)
          || !isfinite (viewport->view_target.y)
          || !isfinite (viewport->view_target.z)
          || !isfinite (viewport->VIEWSIZE)
          || !isfinite (viewport->view_width)
          || !isfinite (viewport->VIEWTWIST)
          || viewport->VIEWSIZE <= 1.0e-12
          || direction_scale <= 1.0e-12
          || viewport->VIEWDIR.z <= 0.0
          || fabs (viewport->VIEWDIR.x)
                 > direction_scale * 1.0e-9
          || fabs (viewport->VIEWDIR.y)
                 > direction_scale * 1.0e-9)
        return;
      cosine = cos (viewport->VIEWTWIST);
      sine = sin (viewport->VIEWTWIST);
      result->center[0]
          = viewport->view_target.x
            + viewport->VIEWCTR.x * cosine
            - viewport->VIEWCTR.y * sine;
      result->center[1]
          = viewport->view_target.y
            + viewport->VIEWCTR.x * sine
            + viewport->VIEWCTR.y * cosine;
      result->center[2] = viewport->view_target.z;
      result->view_height = viewport->VIEWSIZE;
      result->view_width
          = viewport->view_width > 1.0e-12
                ? viewport->view_width
                : viewport->VIEWSIZE;
      result->twist = viewport->VIEWTWIST;
      result->flags = 1u;
      return;
    }
}

static int
write_drawing_section (CacheWriter *writer, Dwg_Data *dwg,
                       const LibreDwgPrimitiveCounts *counts,
                       uint32_t source_version, uint32_t wipeout_frame,
                       uint32_t presentation_settings,
                       SectionEntry *entry)
{
  uint64_t offset;
  uint32_t display_settings
      = wipeout_frame == UINT32_MAX ? 3u : wipeout_frame;
  double min[3];
  double max[3];
  SavedModelView saved_view;
  size_t axis;
  read_saved_model_view (dwg, &saved_view);
  min[0] = dwg_model_x_min (dwg);
  min[1] = dwg_model_y_min (dwg);
  min[2] = dwg_model_z_min (dwg);
  max[0] = dwg_model_x_max (dwg);
  max[1] = dwg_model_y_max (dwg);
  max[2] = dwg_model_z_max (dwg);
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (min[axis]) || !isfinite (max[axis])
          || min[axis] > max[axis])
        {
          memset (min, 0, sizeof (min));
          memset (max, 0, sizeof (max));
          break;
        }
    }
  if (dwg->header_vars.LWDISPLAY)
    display_settings |= 1u << 2;
  if (dwg->header_vars.FILLMODE)
    display_settings |= 1u << 3;
  if (dwg->header_vars.TILEMODE)
    display_settings |= 1u << 4;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, source_version)
      || !write_u32 (writer,
                     (uint32_t)LIBREDWG_MAINTENANCE_VERSION (dwg))
      || !write_i32 (writer, (int32_t)dwg->header_vars.INSUNITS)
      || !write_u32 (writer, display_settings)
      || !write_u64 (writer, counts->total_entities)
      || !write_u64 (writer, counts->serialized_entities)
      || !write_vec3 (writer, min) || !write_vec3 (writer, max)
      || !write_f64 (
          writer,
          isfinite (dwg->header_vars.LTSCALE)
                  && fabs (dwg->header_vars.LTSCALE) > 1.0e-12
              ? fabs (dwg->header_vars.LTSCALE)
              : 1.0)
      || !write_f64 (
          writer,
          isfinite (dwg->header_vars.CELTSCALE)
                  && fabs (dwg->header_vars.CELTSCALE) > 1.0e-12
              ? fabs (dwg->header_vars.CELTSCALE)
              : 1.0)
      || !write_u32 (
          writer,
          dwg->header_vars.PSLTSCALE ? 1u : 0u)
      || !write_u32 (writer, presentation_settings)
      || !write_vec3 (writer, saved_view.center)
      || !write_f64 (writer, saved_view.view_height)
      || !write_f64 (writer, saved_view.view_width)
      || !write_f64 (writer, saved_view.twist)
      || !write_u32 (writer, saved_view.flags)
      || !write_f32 (writer, (float)model_annotation_scale (dwg)))
    return 0;
  return finish_fixed_section (writer, entry, SECTION_DRAWING,
                               DRAWING_RECORD_SIZE, "drawing", offset, 1);
}

static int
checked_string_layout (uint64_t *cursor, const char *value,
                       uint32_t *offset, uint32_t *length)
{
  size_t string_length = strlen (value);
  if (*cursor > UINT32_MAX || string_length > UINT32_MAX
      || string_length > MAX_CACHE_STRING_BYTES
      || *cursor + string_length > UINT32_MAX)
    return 0;
  *offset = (uint32_t)*cursor;
  *length = (uint32_t)string_length;
  *cursor += string_length;
  return 1;
}

static int
write_layer_section (CacheWriter *writer, const CacheTables *tables,
                     SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references;
  size_t i;
  if (tables->layer_count > (SIZE_MAX / (4 * sizeof (uint32_t))))
    {
      set_error (writer, "too many layers for scene cache");
      return 0;
    }
  references
      = tables->layer_count
            ? (uint32_t *)malloc (tables->layer_count * 4 * sizeof (uint32_t))
            : NULL;
  if (tables->layer_count && !references)
    {
      set_error (writer, "out of memory while writing layer table");
      return 0;
    }
  for (i = 0; i < tables->layer_count; i++)
    {
      if (!checked_string_layout (&string_cursor, tables->layers[i].name,
                                  &references[i * 4], &references[i * 4 + 1])
          || !checked_string_layout (
              &string_cursor, tables->layers[i].linetype,
              &references[i * 4 + 2], &references[i * 4 + 3]))
        {
          free (references);
          set_error (writer, "layer string table exceeds its limits");
          return 0;
        }
    }
  string_offset = STRING_TABLE_HEADER_SIZE
                  + (uint64_t)tables->layer_count * LAYER_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->layer_count)
      || !write_u32 (writer, LAYER_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (i = 0; i < tables->layer_count; i++)
    {
      Dwg_Object_LAYER *layer
          = tables->layers[i].object->tio.object->tio.LAYER;
      uint32_t flags = 0;
      int line_weight = dxf_cvt_lweight (layer->linewt);
      if (layer->off)
        flags |= 1u;
      if (layer->frozen)
        flags |= 1u << 1;
      if (layer->locked)
        flags |= 1u << 2;
      if (layer->plotflag)
        flags |= 1u << 3;
      if (layer->is_xref_dep)
        flags |= 1u << 4;
      if (!write_u64 (writer, tables->layers[i].handle)
          || !write_u32 (writer, references[i * 4])
          || !write_u32 (writer, references[i * 4 + 1])
          || !write_u32 (writer, references[i * 4 + 2])
          || !write_u32 (writer, references[i * 4 + 3])
          || !write_u32 (writer, encode_layer_color (&layer->color))
          || !write_u32 (writer, flags)
          || !write_i32 (writer, (int32_t)line_weight)
          || !write_u32 (writer, 0))
        {
          free (references);
          return 0;
        }
    }
  for (i = 0; i < tables->layer_count; i++)
    {
      if (!write_bytes (writer, tables->layers[i].name,
                        strlen (tables->layers[i].name))
          || !write_bytes (writer, tables->layers[i].linetype,
                           strlen (tables->layers[i].linetype)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_LAYERS, LAYER_RECORD_SIZE, "layers", offset,
      (uint64_t)tables->layer_count, SECTION_FLAG_STRING_TABLE);
}

static int
write_block_section (CacheWriter *writer, const CacheTables *tables,
                     SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references;
  size_t i;
  if (tables->block_count > SIZE_MAX / (4 * sizeof (uint32_t)))
    {
      set_error (writer, "too many blocks for scene cache");
      return 0;
    }
  references
      = tables->block_count
            ? (uint32_t *)malloc (tables->block_count * 4 * sizeof (uint32_t))
            : NULL;
  if (tables->block_count && !references)
    {
      set_error (writer, "out of memory while writing block table");
      return 0;
    }
  for (i = 0; i < tables->block_count; i++)
    {
      if (!checked_string_layout (&string_cursor, tables->blocks[i].name,
                                  &references[i * 4],
                                  &references[i * 4 + 1])
          || !checked_string_layout (
              &string_cursor, tables->blocks[i].xref_path,
              &references[i * 4 + 2], &references[i * 4 + 3]))
        {
          free (references);
          set_error (writer, "block string table exceeds its limits");
          return 0;
        }
    }
  string_offset = STRING_TABLE_HEADER_SIZE
                  + (uint64_t)tables->block_count * BLOCK_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->block_count)
      || !write_u32 (writer, BLOCK_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (i = 0; i < tables->block_count; i++)
    {
      Dwg_Object_BLOCK_HEADER *block
          = tables->blocks[i].object->tio.object->tio.BLOCK_HEADER;
      uint32_t flags = 0;
      double base_point[3]
          = { block->base_pt.x, block->base_pt.y, block->base_pt.z };
      if (block->anonymous)
        flags |= 1u;
      if (block->hasattrs)
        flags |= 1u << 1;
      if (block->blkisxref
          || (block->xref_pname && block->xref_pname[0]))
        flags |= 1u << 2;
      if (block->xrefoverlaid)
        flags |= 1u << 3;
      if (block->xref_pname && block->xref_pname[0])
        flags |= 1u << 4;
      if (block->explodable)
        flags |= 1u << 5;
      if (block->block_scaling == 0)
        flags |= 1u << 6;
      if (block->xref_loaded)
        flags |= 1u << 7;
      if (block->is_xref_resolved)
        flags |= 1u << 8;
      if (!write_u64 (writer, tables->blocks[i].handle)
          || !write_u32 (writer, references[i * 4])
          || !write_u32 (writer, references[i * 4 + 1])
          || !write_u32 (writer, (uint32_t)block->num_owned)
          || !write_u32 (writer, (uint32_t)block->num_inserts)
          || !write_u32 (writer, flags)
          || !write_i32 (writer, (int32_t)block->insert_units)
          || !write_vec3 (writer, base_point)
          || !write_u32 (writer, references[i * 4 + 2])
          || !write_u32 (writer, references[i * 4 + 3]))
        {
          free (references);
          return 0;
        }
    }
  for (i = 0; i < tables->block_count; i++)
    {
      if (!write_bytes (writer, tables->blocks[i].name,
                        strlen (tables->blocks[i].name))
          || !write_bytes (writer, tables->blocks[i].xref_path,
                           strlen (tables->blocks[i].xref_path)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_BLOCKS, BLOCK_RECORD_SIZE, "blocks", offset,
      (uint64_t)tables->block_count, SECTION_FLAG_STRING_TABLE);
}

static int16_t
normalize_mtext_flow_direction (int value)
{
  if (value == 1)
    return 1;
  if (value == 3)
    return 2;
  if (value == 5)
    return 3;
  return 0;
}

static void
free_text_source (TextSource *source)
{
  free (source->value);
  free (source->tag);
  free (source->prompt);
  source->value = NULL;
  source->tag = NULL;
  source->prompt = NULL;
}

static void
copy_embedded_mtext (TextSource *source,
                     const Dwg_AcDbMTextObjectEmbedded *mtext)
{
  source->insertion_point[0] = mtext->ins_pt.x;
  source->insertion_point[1] = mtext->ins_pt.y;
  source->insertion_point[2] = mtext->ins_pt.z;
  source->attachment = (int16_t)mtext->attachment;
  source->x_axis_direction[0] = mtext->x_axis_dir.x;
  source->x_axis_direction[1] = mtext->x_axis_dir.y;
  source->x_axis_direction[2] = mtext->x_axis_dir.z;
  source->rectangle_height = mtext->rect_height;
  source->rectangle_width = mtext->rect_width;
  source->extents_width = mtext->extents_width;
  source->extents_height = mtext->extents_height;
  source->column_type = (int32_t)mtext->column_type;
  source->column_count = (int32_t)mtext->num_column_heights;
  source->column_width = mtext->column_width;
  source->column_gutter = mtext->gutter;
  if (mtext->auto_height)
    source->column_flags |= 1u;
  if (mtext->flow_reversed)
    source->column_flags |= 1u << 1;
  if (mtext->num_column_heights > 0 && mtext->column_heights)
    {
      source->column_heights = mtext->column_heights;
      source->column_height_count
          = (uint64_t)mtext->num_column_heights;
    }
}

static int
read_text_source (const Dwg_Data *dwg, const Dwg_Object *object,
                  TextSource *source)
{
  const char *value_type;
  const char *value_field;
  const char *tag_type = "";
  const char *prompt_type = "";
  memset (source, 0, sizeof (*source));
  source->object = object;
  source->normal[2] = 1.0;
  source->x_axis_direction[0] = 1.0;
  source->width_factor = 1.0;
  source->line_count = 1;
  if (!object || !object->tio.entity)
    return 0;

  switch (object->fixedtype)
    {
    case DWG_TYPE_TEXT:
      {
        const Dwg_Entity_TEXT *text = object->tio.entity->tio.TEXT;
        if (!text)
          return 0;
        source->kind = 0;
        value_type = "TEXT";
        value_field = "text_value";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->elevation;
        source->alignment_point[0] = text->alignment_pt.x;
        source->alignment_point[1] = text->alignment_pt.y;
        source->alignment_point[2] = text->elevation;
        if ((text->dataflags & 2u) || text->horiz_alignment
            || text->vert_alignment)
          source->flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->height = text->height;
        source->width_factor = text->width_factor;
        source->rotation = text->rotation;
        source->oblique_angle = text->oblique_angle;
        source->thickness = text->thickness;
        source->x_axis_direction[0] = cos (text->rotation);
        source->x_axis_direction[1] = sin (text->rotation);
        source->horizontal_alignment
            = (int16_t)text->horiz_alignment;
        source->vertical_alignment = (int16_t)text->vert_alignment;
        source->generation_flags = (int16_t)text->generation;
        break;
      }
    case DWG_TYPE_MTEXT:
      {
        const Dwg_Entity_MTEXT *text = object->tio.entity->tio.MTEXT;
        if (!text)
          return 0;
        source->kind = 1;
        value_type = "MTEXT";
        value_field = "text";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->ins_pt.z;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->x_axis_direction[0] = text->x_axis_dir.x;
        source->x_axis_direction[1] = text->x_axis_dir.y;
        source->x_axis_direction[2] = text->x_axis_dir.z;
        source->rotation
            = atan2 (text->x_axis_dir.y, text->x_axis_dir.x);
        source->height = text->text_height;
        source->rectangle_width = text->rect_width;
        source->rectangle_height = text->rect_height;
        source->flags |= TEXT_FLAG_HAS_RECTANGLE_HEIGHT;
        if (text_annotation_context_count (dwg, object, NULL) > 0)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        source->extents_width = text->extents_width;
        source->extents_height = text->extents_height;
        source->attachment = (int16_t)text->attachment;
        source->flow_direction
            = normalize_mtext_flow_direction (text->flow_dir);
        source->line_spacing_style = (int16_t)text->linespace_style;
        source->line_spacing_factor = text->linespace_factor;
        source->background_flags = (int32_t)text->bg_fill_flag;
        source->background_scale = (double)text->bg_fill_scale;
        source->background_color
            = encode_color (&text->bg_fill_color);
        source->background_transparency
            = (int32_t)text->bg_fill_trans;
        source->column_type = (int32_t)text->column_type;
        source->column_count
            = text->column_type == 1 ? (int32_t)text->numfragments
                                     : (int32_t)text->num_column_heights;
        source->column_width = text->column_width;
        source->column_gutter = text->gutter;
        if (text->auto_height)
          source->column_flags |= 1u;
        if (text->flow_reversed)
          source->column_flags |= 1u << 1;
        if (text->num_column_heights > 0 && text->column_heights)
          {
            source->column_heights = text->column_heights;
            source->column_height_count
                = (uint64_t)text->num_column_heights;
          }
        source->line_count = 0;
        break;
      }
    case DWG_TYPE_ATTDEF:
      {
        const Dwg_Entity_ATTDEF *text = object->tio.entity->tio.ATTDEF;
        if (!text)
          return 0;
        source->kind = 2;
        value_type = "ATTDEF";
        value_field = "default_value";
        tag_type = "ATTDEF";
        prompt_type = "ATTDEF";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->elevation;
        source->alignment_point[0] = text->alignment_pt.x;
        source->alignment_point[1] = text->alignment_pt.y;
        source->alignment_point[2] = text->elevation;
        source->flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
        if (text->annotative_flag)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        if (text->mtext_type)
          source->flags |= TEXT_FLAG_MULTILINE;
        if (text->lock_position_flag)
          source->flags |= TEXT_FLAG_LOCK_POSITION;
        if (text->is_really_locked)
          source->flags |= TEXT_FLAG_REALLY_LOCKED;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->height = text->height;
        source->width_factor = text->width_factor;
        source->rotation = text->rotation;
        source->oblique_angle = text->oblique_angle;
        source->thickness = text->thickness;
        source->x_axis_direction[0] = cos (text->rotation);
        source->x_axis_direction[1] = sin (text->rotation);
        source->source_flags = (int32_t)text->flags;
        source->horizontal_alignment
            = (int16_t)text->horiz_alignment;
        source->vertical_alignment = (int16_t)text->vert_alignment;
        source->generation_flags = (int16_t)text->generation;
        source->field_length = (int16_t)text->field_length;
        source->mtext_type = (int16_t)text->mtext_type;
        if (text->mtext_type)
          copy_embedded_mtext (source, &text->mtext);
        break;
      }
    case DWG_TYPE_ATTRIB:
      {
        const Dwg_Entity_ATTRIB *text = object->tio.entity->tio.ATTRIB;
        if (!text)
          return 0;
        source->kind = 3;
        value_type = "ATTRIB";
        value_field = "text_value";
        tag_type = "ATTRIB";
        source->style = text->style;
        source->insertion_point[0] = text->ins_pt.x;
        source->insertion_point[1] = text->ins_pt.y;
        source->insertion_point[2] = text->elevation;
        source->alignment_point[0] = text->alignment_pt.x;
        source->alignment_point[1] = text->alignment_pt.y;
        source->alignment_point[2] = text->elevation;
        source->flags |= TEXT_FLAG_HAS_ALIGNMENT_POINT;
        if (text->annotative_flag)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        if (text->mtext_type)
          source->flags |= TEXT_FLAG_MULTILINE;
        if (text->lock_position_flag)
          source->flags |= TEXT_FLAG_LOCK_POSITION;
        if (text->is_really_locked)
          source->flags |= TEXT_FLAG_REALLY_LOCKED;
        finite_normal_or_unit_z (text->extrusion.x, text->extrusion.y,
                                 text->extrusion.z, source->normal);
        source->height = text->height;
        source->width_factor = text->width_factor;
        source->rotation = text->rotation;
        source->oblique_angle = text->oblique_angle;
        source->thickness = text->thickness;
        source->x_axis_direction[0] = cos (text->rotation);
        source->x_axis_direction[1] = sin (text->rotation);
        source->source_flags = (int32_t)text->flags;
        source->horizontal_alignment
            = (int16_t)text->horiz_alignment;
        source->vertical_alignment = (int16_t)text->vert_alignment;
        source->generation_flags = (int16_t)text->generation;
        source->field_length = (int16_t)text->field_length;
        source->mtext_type = (int16_t)text->mtext_type;
        if (text->mtext_type)
          copy_embedded_mtext (source, &text->mtext);
        break;
      }
    case DWG_TYPE_MULTILEADER:
      {
        const Dwg_Entity_MULTILEADER *mleader
            = object->tio.entity->tio.MULTILEADER;
        const Dwg_MLEADER_Content_MText *text;
        if (!mleader || !mleader->ctx.has_content_txt)
          return 0;
        text = &mleader->ctx.content.txt;
        source->kind = 1;
        value_type = "";
        value_field = "";
        source->style
            = text->style ? text->style : mleader->text_style;
        source->insertion_point[0] = text->location.x;
        source->insertion_point[1] = text->location.y;
        source->insertion_point[2] = text->location.z;
        finite_normal_or_unit_z (text->normal.x, text->normal.y,
                                 text->normal.z, source->normal);
        source->x_axis_direction[0] = text->direction.x;
        source->x_axis_direction[1] = text->direction.y;
        source->x_axis_direction[2] = text->direction.z;
        if (!isfinite (source->x_axis_direction[0])
            || !isfinite (source->x_axis_direction[1])
            || !isfinite (source->x_axis_direction[2])
            || (fabs (source->x_axis_direction[0]) <= 1.0e-12
                && fabs (source->x_axis_direction[1]) <= 1.0e-12))
          {
            source->x_axis_direction[0] = cos (text->rotation);
            source->x_axis_direction[1] = sin (text->rotation);
            source->x_axis_direction[2] = 0.0;
          }
        source->rotation = isfinite (text->rotation)
                               ? text->rotation
                               : atan2 (source->x_axis_direction[1],
                                        source->x_axis_direction[0]);
        source->height
            = isfinite (mleader->ctx.text_height)
                      && mleader->ctx.text_height > 1.0e-12
                  ? mleader->ctx.text_height
                  : isfinite (text->height) && text->height > 1.0e-12
                        ? text->height
                        : 1.0;
        source->rectangle_width
            = isfinite (text->width) && text->width > 0.0
                  ? text->width
                  : 0.0;
        source->rectangle_height
            = isfinite (text->height) && text->height > 0.0
                  ? text->height
                  : 0.0;
        source->extents_width = source->rectangle_width;
        source->extents_height = source->rectangle_height;
        source->flags |= TEXT_FLAG_HAS_RECTANGLE_HEIGHT;
        if (mleader->is_annotative)
          source->flags |= TEXT_FLAG_ANNOTATIVE;
        source->attachment
            = text->alignment >= 1 && text->alignment <= 9
                  ? (int16_t)text->alignment
                  : 1;
        source->flow_direction
            = normalize_mtext_flow_direction (text->flow);
        source->line_spacing_style
            = (int16_t)text->line_spacing_style;
        source->line_spacing_factor
            = isfinite (text->line_spacing_factor)
                      && text->line_spacing_factor > 0.0
                  ? text->line_spacing_factor
                  : 1.0;
        if (text->is_bg_fill || text->is_bg_mask_fill)
          source->background_flags = 1;
        source->background_scale
            = isfinite (text->bg_scale) && text->bg_scale > 0.0
                  ? text->bg_scale
                  : 1.0;
        source->background_color = encode_color (&text->bg_color);
        source->background_transparency
            = (int32_t)text->bg_transparency;
        source->source_flags = mleader->has_text_frame ? 1 : 0;
        source->line_count = 0;
        break;
      }
    default:
      return 0;
    }

  if (is_supported_text_annotation_owner (object)
      && text_annotation_context_count (dwg, object, NULL) > 0)
    source->flags |= TEXT_FLAG_ANNOTATIVE;

  if (object->fixedtype == DWG_TYPE_MULTILEADER)
    source->value = copy_versioned_text (
        dwg->header.codepage, dwg->header.version,
        object->tio.entity->tio.MULTILEADER->ctx.content.txt.default_text);
  else
    source->value = copy_utf8_field (
        dwg->header.codepage,
        (void *)(source->kind == 0
                     ? (void *)object->tio.entity->tio.TEXT
                     : source->kind == 1
                           ? (void *)object->tio.entity->tio.MTEXT
                           : source->kind == 2
                                 ? (void *)object->tio.entity->tio.ATTDEF
                                 : (void *)object->tio.entity->tio.ATTRIB),
        value_type, value_field, "");
  source->tag = copy_utf8_field (
      dwg->header.codepage,
      source->kind == 2
          ? (void *)object->tio.entity->tio.ATTDEF
          : source->kind == 3 ? (void *)object->tio.entity->tio.ATTRIB : NULL,
      tag_type, "tag", "");
  source->prompt = copy_utf8_field (
      dwg->header.codepage,
      source->kind == 2 ? (void *)object->tio.entity->tio.ATTDEF : NULL,
      prompt_type, "prompt", "");
  if (!source->value || !source->tag || !source->prompt)
    {
      free_text_source (source);
      return 0;
    }
  return 1;
}

static int
proxy_read_vec3 (const uint8_t *data, size_t size, size_t offset,
                 double value[3])
{
  size_t axis;
  for (axis = 0; axis < 3u; axis++)
    if (!proxy_read_f64 (data, size, offset + axis * sizeof (double),
                         &value[axis])
        || !isfinite (value[axis]))
      return 0;
  return 1;
}

static int
proxy_append_utf8 (char *output, size_t capacity, size_t *length,
                   uint32_t codepoint)
{
  uint8_t bytes[4];
  size_t count;
  size_t index;
  if (codepoint <= 0x7fu)
    {
      bytes[0] = (uint8_t)codepoint;
      count = 1u;
    }
  else if (codepoint <= 0x7ffu)
    {
      bytes[0] = (uint8_t)(0xc0u | (codepoint >> 6u));
      bytes[1] = (uint8_t)(0x80u | (codepoint & 0x3fu));
      count = 2u;
    }
  else if (codepoint <= 0xffffu)
    {
      bytes[0] = (uint8_t)(0xe0u | (codepoint >> 12u));
      bytes[1] = (uint8_t)(0x80u | ((codepoint >> 6u) & 0x3fu));
      bytes[2] = (uint8_t)(0x80u | (codepoint & 0x3fu));
      count = 3u;
    }
  else if (codepoint <= 0x10ffffu)
    {
      bytes[0] = (uint8_t)(0xf0u | (codepoint >> 18u));
      bytes[1] = (uint8_t)(0x80u | ((codepoint >> 12u) & 0x3fu));
      bytes[2] = (uint8_t)(0x80u | ((codepoint >> 6u) & 0x3fu));
      bytes[3] = (uint8_t)(0x80u | (codepoint & 0x3fu));
      count = 4u;
    }
  else
    return 0;
  if (*length > capacity || count > capacity - *length)
    return 0;
  for (index = 0; index < count; index++)
    output[(*length)++] = (char)bytes[index];
  return 1;
}

static int
proxy_read_utf16_string (const uint8_t *data, size_t size,
                         size_t *cursor, char **value)
{
  size_t start;
  size_t end;
  size_t units;
  size_t output_capacity;
  size_t output_length = 0;
  size_t position;
  char *output;
  if (!data || !cursor || !value || *cursor > size)
    return 0;
  start = *cursor;
  end = start;
  while (end <= size && size - end >= 2u)
    {
      uint16_t unit;
      if (!proxy_read_u16 (data, size, end, &unit))
        return 0;
      if (unit == 0u)
        break;
      end += 2u;
    }
  if (end > size || size - end < 2u)
    return 0;
  units = (end - start) / 2u;
  if (units > MAX_PROXY_GRAPHIC_UTF16_UNITS
      || units > (SIZE_MAX - 1u) / 4u)
    return 0;
  output_capacity = units * 4u;
  output = (char *)malloc (output_capacity + 1u);
  if (!output)
    return 0;
  position = start;
  while (position < end)
    {
      uint16_t first;
      uint32_t codepoint;
      if (!proxy_read_u16 (data, size, position, &first))
        goto invalid_string;
      position += 2u;
      if (first >= 0xd800u && first <= 0xdbffu)
        {
          uint16_t second;
          if (position < end
              && proxy_read_u16 (data, size, position, &second)
              && second >= 0xdc00u && second <= 0xdfffu)
            {
              position += 2u;
              codepoint = 0x10000u
                          + (((uint32_t)first - 0xd800u) << 10u)
                          + ((uint32_t)second - 0xdc00u);
            }
          else
            codepoint = 0xfffdu;
        }
      else if (first >= 0xdc00u && first <= 0xdfffu)
        codepoint = 0xfffdu;
      else
        codepoint = first;
      if (!proxy_append_utf8 (
              output, output_capacity, &output_length, codepoint))
        goto invalid_string;
    }
  output[output_length] = '\0';
  if (!proxy_align4 (end + 2u, cursor) || *cursor > size)
    goto invalid_string;
  *value = output;
  return 1;

invalid_string:
  free (output);
  return 0;
}

static double
proxy_vector_length (const double vector[3])
{
  return sqrt (vector[0] * vector[0] + vector[1] * vector[1]
               + vector[2] * vector[2]);
}

static int
proxy_normalize_vector (double vector[3])
{
  double length = proxy_vector_length (vector);
  size_t axis;
  if (!isfinite (length) || length <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3u; axis++)
    vector[axis] /= length;
  return 1;
}

static int
ascii_case_equal (const char *left, const char *right)
{
  if (!left || !right)
    return 0;
  while (*left && *right)
    {
      unsigned char a = (unsigned char)*left++;
      unsigned char b = (unsigned char)*right++;
      if (a >= 'A' && a <= 'Z')
        a = (unsigned char)(a + ('a' - 'A'));
      if (b >= 'A' && b <= 'Z')
        b = (unsigned char)(b + ('a' - 'A'));
      if (a != b)
        return 0;
    }
  return *left == '\0' && *right == '\0';
}

static uint32_t
proxy_text_style_index (const CacheTables *tables, const char *typeface,
                        const char *font, const char *bigfont)
{
  size_t index;
  if (!tables)
    return UINT32_MAX;
  for (index = 0; index < tables->text_style_count; index++)
    {
      const TextStyleEntry *style = &tables->text_styles[index];
      if ((font && font[0]
           && ascii_case_equal (font, style->font_file))
          || (bigfont && bigfont[0]
              && ascii_case_equal (bigfont, style->bigfont_file))
          || (typeface && typeface[0]
              && ascii_case_equal (typeface, style->name)))
        return (uint32_t)index;
    }
  return UINT32_MAX;
}

static int
read_proxy_unicode_text2 (const Dwg_Object *object,
                          const CacheTables *tables,
                          const ProxyGraphicState *state,
                          const ProxyGraphicChunk *chunk,
                          uint64_t serialized_handle,
                          TextSource *source)
{
  double insertion[3];
  double normal[3];
  double direction[3];
  double local_y[3];
  double transformed_x[3];
  double transformed_y[3];
  double transformed_normal[3];
  double x_scale;
  double y_scale;
  uint32_t flags[9];
  char *value = NULL;
  char *typeface = NULL;
  char *font = NULL;
  char *bigfont = NULL;
  size_t cursor = 0;
  size_t index;
  int result = 0;
  if (!object || !tables || !state || !chunk || !source
      || chunk->type != PROXY_GRAPHIC_UNICODE_TEXT2)
    return 0;
  memset (source, 0, sizeof (*source));
  if (!proxy_read_vec3 (chunk->data, chunk->size, cursor, insertion))
    goto done;
  cursor += 3u * sizeof (double);
  if (!proxy_read_vec3 (chunk->data, chunk->size, cursor, normal))
    goto done;
  cursor += 3u * sizeof (double);
  if (!proxy_read_vec3 (chunk->data, chunk->size, cursor, direction))
    goto done;
  cursor += 3u * sizeof (double);
  if (!proxy_read_utf16_string (
          chunk->data, chunk->size, &cursor, &value)
      || cursor > chunk->size || chunk->size - cursor < 8u)
    goto done;
  cursor += 8u;
  if (!proxy_read_f64 (
          chunk->data, chunk->size, cursor, &source->height)
      || !proxy_read_f64 (
          chunk->data, chunk->size, cursor + 8u,
          &source->width_factor)
      || !proxy_read_f64 (
          chunk->data, chunk->size, cursor + 16u,
          &source->oblique_angle)
      || !isfinite (source->height)
      || !isfinite (source->width_factor)
      || !isfinite (source->oblique_angle))
    goto done;
  cursor += 4u * sizeof (double);
  for (index = 0; index < 9u; index++)
    if (!proxy_read_u32 (
            chunk->data, chunk->size, cursor + index * 4u,
            &flags[index]))
      goto done;
  cursor += 9u * sizeof (uint32_t);
  if (!proxy_read_utf16_string (
          chunk->data, chunk->size, &cursor, &typeface)
      || !proxy_read_utf16_string (
          chunk->data, chunk->size, &cursor, &font)
      || !proxy_read_utf16_string (
          chunk->data, chunk->size, &cursor, &bigfont))
    goto done;

  local_y[0] = normal[1] * direction[2] - normal[2] * direction[1];
  local_y[1] = normal[2] * direction[0] - normal[0] * direction[2];
  local_y[2] = normal[0] * direction[1] - normal[1] * direction[0];
  proxy_transform_point (state, insertion, source->insertion_point);
  proxy_transform_vector (state, direction, transformed_x);
  proxy_transform_vector (state, local_y, transformed_y);
  proxy_transform_vector (state, normal, transformed_normal);
  x_scale = proxy_vector_length (transformed_x)
            / fmax (proxy_vector_length (direction), CURVE_EPSILON);
  y_scale = proxy_vector_length (transformed_y)
            / fmax (proxy_vector_length (local_y), CURVE_EPSILON);
  if (!isfinite (x_scale) || !isfinite (y_scale)
      || x_scale <= CURVE_EPSILON || y_scale <= CURVE_EPSILON
      || !proxy_normalize_vector (transformed_x)
      || !proxy_normalize_vector (transformed_normal))
    goto done;
  memcpy (source->x_axis_direction, transformed_x,
          sizeof (source->x_axis_direction));
  memcpy (source->normal, transformed_normal, sizeof (source->normal));
  source->height = fabs (source->height) * y_scale;
  source->width_factor
      = fabs (source->width_factor) * x_scale / y_scale;
  if (!isfinite (source->height)
      || source->height <= CURVE_EPSILON
      || !isfinite (source->width_factor)
      || source->width_factor <= CURVE_EPSILON)
    goto done;
  source->rotation
      = atan2 (source->x_axis_direction[1],
               source->x_axis_direction[0]);
  source->object = object;
  source->kind = 0u;
  source->value = value;
  value = NULL;
  source->tag = strdup ("");
  source->prompt = strdup ("");
  if (!source->tag || !source->prompt)
    goto done;
  source->line_count = 1;
  source->generation_flags
      = (int16_t)((flags[0] ? 2u : 0u)
                  | (flags[1] ? 4u : 0u));
  source->linked_handle = (uint64_t)object->handle.value;
  source->serialized_handle = serialized_handle;
  source->common_color = state->color;
  source->common_linetype_code = state->linetype_code;
  source->common_line_weight = state->line_weight;
  source->has_common_override = 1;
  source->style_index_override
      = proxy_text_style_index (tables, typeface, font, bigfont);
  source->has_style_index_override = 1;
  result = 1;

done:
  free (value);
  free (typeface);
  free (font);
  free (bigfont);
  if (!result)
    free_text_source (source);
  return result;
}

static uint64_t
maximum_drawing_object_handle (const Dwg_Data *dwg)
{
  uint64_t maximum = 0;
  size_t index;
  if (!dwg)
    return 0;
  for (index = 0; index < (size_t)dwg->num_objects; index++)
    if ((uint64_t)dwg->object[index].handle.value > maximum)
      maximum = (uint64_t)dwg->object[index].handle.value;
  return maximum;
}

typedef int (*TextSourceConsumer) (void *context,
                                   const TextSource *source);

static int
scene_text_source_count (const Dwg_Data *dwg,
                         const CacheTables *tables, uint64_t *count)
{
  uint64_t total = 0;
  size_t object_index;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    if (is_text_source_object (&dwg->object[object_index]))
      total++;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      ProxyGraphicReader reader;
      ProxyGraphicState state;
      ProxyGraphicChunk chunk;
      uint32_t entity_texts = 0;
      int status;
      if (!proxy_graphic_has_supported_display (object)
          || !initialize_proxy_graphic_reader (object, &reader))
        continue;
      initialize_proxy_graphic_state (object, tables, &state);
      while ((status = next_proxy_graphic_chunk (&reader, &chunk)) > 0)
        {
          int control = apply_proxy_graphic_control (&state, &chunk);
          if (control < 0)
            return 0;
          if (control > 0
              || chunk.type != PROXY_GRAPHIC_UNICODE_TEXT2)
            continue;
          if (entity_texts >= MAX_PROXY_GRAPHIC_TEXTS_PER_ENTITY
              || total == UINT64_MAX)
            return 0;
          entity_texts++;
          total++;
        }
      if (status < 0)
        return 0;
    }
  *count = total;
  return 1;
}

static int
for_each_scene_text_source (const Dwg_Data *dwg,
                            const CacheTables *tables,
                            TextSourceConsumer consumer, void *context)
{
  uint64_t synthetic_handle;
  size_t object_index;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      TextSource source;
      int accepted;
      if (!is_text_source_object (&dwg->object[object_index]))
        continue;
      if (!read_text_source (dwg, &dwg->object[object_index], &source))
        return 0;
      accepted = !consumer || consumer (context, &source);
      free_text_source (&source);
      if (!accepted)
        return 0;
    }
  synthetic_handle = maximum_drawing_object_handle (dwg);
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      ProxyGraphicReader reader;
      ProxyGraphicState state;
      ProxyGraphicChunk chunk;
      uint32_t entity_texts = 0;
      int status;
      if (!proxy_graphic_has_supported_display (object)
          || !initialize_proxy_graphic_reader (object, &reader))
        continue;
      initialize_proxy_graphic_state (object, tables, &state);
      while ((status = next_proxy_graphic_chunk (&reader, &chunk)) > 0)
        {
          TextSource source;
          int accepted;
          int control = apply_proxy_graphic_control (&state, &chunk);
          if (control < 0)
            return 0;
          if (control > 0
              || chunk.type != PROXY_GRAPHIC_UNICODE_TEXT2)
            continue;
          if (entity_texts >= MAX_PROXY_GRAPHIC_TEXTS_PER_ENTITY
              || synthetic_handle == UINT64_MAX)
            return 0;
          synthetic_handle++;
          if (!read_proxy_unicode_text2 (
                  object, tables, &state, &chunk, synthetic_handle,
                  &source))
            return 0;
          accepted = !consumer || consumer (context, &source);
          free_text_source (&source);
          if (!accepted)
            return 0;
          entity_texts++;
        }
      if (status < 0)
        return 0;
    }
  return 1;
}

static int
write_text_source_common (CacheWriter *writer, const TextSource *source,
                          const CacheTables *tables)
{
  const Dwg_Object_Entity *entity;
  if (!source->has_common_override)
    return write_common (writer, source->object, tables);
  entity = source->object ? source->object->tio.entity : NULL;
  return write_u64 (writer, source->serialized_handle)
         && write_u64 (writer, entity_owner_handle (entity, tables))
         && write_u32 (writer, entity_layer_index (entity, tables))
         && write_u32 (writer, source->common_color)
         && write_i16 (writer, source->common_line_weight)
         && write_u16 (
             writer, entity && entity->invisible ? 1u : 0u)
         && write_u32 (writer, source->common_linetype_code);
}

static int
write_text_style_section (CacheWriter *writer, const CacheTables *tables,
                          SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references;
  size_t i;
  if (tables->text_style_count > SIZE_MAX / (8 * sizeof (uint32_t)))
    {
      set_error (writer, "too many text styles for scene cache");
      return 0;
    }
  references
      = tables->text_style_count
            ? (uint32_t *)malloc (tables->text_style_count * 8
                                 * sizeof (uint32_t))
            : NULL;
  if (tables->text_style_count && !references)
    {
      set_error (writer, "out of memory while writing text-style table");
      return 0;
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      TextStyleEntry *style = &tables->text_styles[i];
      if (!checked_string_layout (&string_cursor, style->name,
                                  &references[i * 8],
                                  &references[i * 8 + 1])
          || !checked_string_layout (&string_cursor, style->font_file,
                                     &references[i * 8 + 2],
                                     &references[i * 8 + 3])
          || !checked_string_layout (&string_cursor, style->bigfont_file,
                                     &references[i * 8 + 4],
                                     &references[i * 8 + 5])
          || !checked_string_layout (&string_cursor, "",
                                     &references[i * 8 + 6],
                                     &references[i * 8 + 7]))
        {
          free (references);
          set_error (writer, "text-style string table exceeds its limits");
          return 0;
        }
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE
        + (uint64_t)tables->text_style_count * TEXT_STYLE_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->text_style_count)
      || !write_u32 (writer, TEXT_STYLE_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      Dwg_Object_STYLE *style
          = tables->text_styles[i].object->tio.object->tio.STYLE;
      uint32_t flags = 0;
      size_t j;
      if ((style->generation & 2u) || (style->flag & 128u))
        flags |= 1u;
      if ((style->generation & 4u) || (style->flag & 2u))
        flags |= 1u << 1;
      if (style->is_xref_dep)
        flags |= 1u << 2;
      if (style->is_vertical)
        flags |= 1u << 4;
      if (style->is_shape)
        flags |= 1u << 5;
      if (!write_u64 (writer, tables->text_styles[i].handle))
        {
          free (references);
          return 0;
        }
      for (j = 0; j < 8; j++)
        {
          if (!write_u32 (writer, references[i * 8 + j]))
            {
              free (references);
              return 0;
            }
        }
      if (!write_u32 (writer, flags) || !write_u32 (writer, 0)
          || !write_f64 (writer, style->text_size)
          || !write_f64 (writer, style->width_factor)
          || !write_f64 (writer, style->oblique_angle)
          || !write_f64 (writer, style->last_height)
          || !write_u64 (writer, 0) || !write_u64 (writer, 0))
        {
          free (references);
          return 0;
        }
    }
  for (i = 0; i < tables->text_style_count; i++)
    {
      if (!write_bytes (writer, tables->text_styles[i].name,
                        strlen (tables->text_styles[i].name))
          || !write_bytes (writer, tables->text_styles[i].font_file,
                           strlen (tables->text_styles[i].font_file))
          || !write_bytes (writer, tables->text_styles[i].bigfont_file,
                           strlen (tables->text_styles[i].bigfont_file)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_TEXT_STYLES, TEXT_STYLE_RECORD_SIZE,
      "text_styles", offset, (uint64_t)tables->text_style_count,
      SECTION_FLAG_STRING_TABLE);
}

static int
serialized_linetype_dash_count (const Dwg_Data *dwg,
                                const Dwg_Object_LTYPE *linetype,
                                size_t *result)
{
  size_t count;
  if (!dwg || !linetype || !result)
    return 0;
  count = (size_t)linetype->numdashes;
  if (dwg->header.version < R_13b1)
    {
      if (count > 12u)
        return 0;
    }
  else if (count && !linetype->dashes)
    return 0;
  *result = count;
  return 1;
}

static uint64_t
linetype_dash_count (const Dwg_Data *dwg, const CacheTables *tables)
{
  uint64_t count = 0;
  size_t index;
  for (index = 0; index < tables->linetype_count; index++)
    {
      const Dwg_Object_LTYPE *linetype
          = tables->linetypes[index].object->tio.object->tio.LTYPE;
      size_t dash_count;
      if (!serialized_linetype_dash_count (
              dwg, linetype, &dash_count)
          || UINT64_MAX - count < (uint64_t)dash_count)
        return UINT64_MAX;
      count += (uint64_t)dash_count;
    }
  return count;
}

static int
write_linetype_section (CacheWriter *writer, const Dwg_Data *dwg,
                        const CacheTables *tables,
                        SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint64_t first_dash = 0;
  uint32_t *references;
  size_t index;
  references
      = tables->linetype_count
            ? (uint32_t *)malloc (tables->linetype_count * 4
                                 * sizeof (uint32_t))
            : NULL;
  if (tables->linetype_count && !references)
    {
      set_error (writer, "out of memory while writing linetype table");
      return 0;
    }
  for (index = 0; index < tables->linetype_count; index++)
    {
      if (!checked_string_layout (
              &string_cursor, tables->linetypes[index].name,
              &references[index * 4], &references[index * 4 + 1])
          || !checked_string_layout (
              &string_cursor, tables->linetypes[index].description,
              &references[index * 4 + 2],
              &references[index * 4 + 3]))
        {
          free (references);
          set_error (writer, "linetype string table exceeds its limits");
          return 0;
        }
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE
        + (uint64_t)tables->linetype_count * LINETYPE_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)tables->linetype_count)
      || !write_u32 (writer, LINETYPE_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    {
      free (references);
      return 0;
    }
  for (index = 0; index < tables->linetype_count; index++)
    {
      const LinetypeEntry *entry_source = &tables->linetypes[index];
      const Dwg_Object_LTYPE *linetype
          = entry_source->object->tio.object->tio.LTYPE;
      uint32_t flags = 0;
      size_t dash_count;
      size_t dash_index;
      double pattern_length = isfinite (linetype->pattern_len)
                                  ? fabs (linetype->pattern_len)
                                  : 0.0;
      if (!serialized_linetype_dash_count (
              dwg, linetype, &dash_count))
        {
          free (references);
          set_error (writer, "linetype dash data is invalid");
          return 0;
        }
      for (dash_index = 0; dash_index < dash_count; dash_index++)
        if (dwg->header.version >= R_13b1
            && linetype->dashes[dash_index].shape_flag)
          flags |= 1u;
      if (!write_u64 (writer, entry_source->handle)
          || !write_u32 (writer, entry_source->code)
          || !write_u16 (writer, (uint16_t)linetype->alignment)
          || !write_u16 (writer, (uint16_t)flags)
          || !write_f64 (writer, pattern_length)
          || !write_u64 (writer, first_dash)
          || !write_u32 (writer, (uint32_t)dash_count)
          || !write_u32 (writer, references[index * 4])
          || !write_u32 (writer, references[index * 4 + 1])
          || !write_u32 (writer, references[index * 4 + 2])
          || !write_u32 (writer, references[index * 4 + 3])
          || !write_u32 (writer, 0) || !write_u32 (writer, 0)
          || !write_u32 (writer, 0))
        {
          free (references);
          return 0;
        }
      first_dash += (uint64_t)dash_count;
    }
  for (index = 0; index < tables->linetype_count; index++)
    {
      if (!write_bytes (writer, tables->linetypes[index].name,
                        strlen (tables->linetypes[index].name))
          || !write_bytes (
              writer, tables->linetypes[index].description,
              strlen (tables->linetypes[index].description)))
        {
          free (references);
          return 0;
        }
    }
  free (references);
  return finish_variable_section (
      writer, entry, SECTION_LINETYPES, LINETYPE_RECORD_SIZE,
      "linetypes", offset, (uint64_t)tables->linetype_count,
      SECTION_FLAG_STRING_TABLE);
}

static int
write_linetype_dash_section (CacheWriter *writer, const Dwg_Data *dwg,
                             const CacheTables *tables,
                             SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = linetype_dash_count (dwg, tables);
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint32_t *references = NULL;
  char **texts = NULL;
  uint64_t cursor = 0;
  size_t linetype_index;
  int success = 0;
  if (count == UINT64_MAX || count > SIZE_MAX / sizeof (char *)
      || count > SIZE_MAX / (2 * sizeof (uint32_t))
      || count > UINT32_MAX)
    {
      set_error (writer, "linetype dash table exceeds its limits");
      return 0;
    }
  if (count)
    {
      texts = (char **)calloc ((size_t)count, sizeof (char *));
      references
          = (uint32_t *)malloc ((size_t)count * 2 * sizeof (uint32_t));
      if (!texts || !references)
        {
          set_error (
              writer,
              "out of memory while writing linetype dash table");
          goto done;
        }
    }
  for (linetype_index = 0;
       linetype_index < tables->linetype_count; linetype_index++)
    {
      Dwg_Object_LTYPE *linetype
          = tables->linetypes[linetype_index].object->tio.object->tio.LTYPE;
      size_t dash_count;
      size_t dash_index;
      if (!serialized_linetype_dash_count (
              dwg, linetype, &dash_count))
        {
          set_error (writer, "linetype dash data is invalid");
          goto done;
        }
      for (dash_index = 0; dash_index < dash_count;
           dash_index++, cursor++)
        {
          if (cursor >= count || !texts || !references)
            {
              set_error (writer, "linetype dash count changed while writing");
              goto done;
            }
          if (dwg->header.version < R_13b1)
            texts[cursor] = strdup ("");
          else
            {
              Dwg_LTYPE_dash *dash = &linetype->dashes[dash_index];
              texts[cursor] = copy_utf8_field (
                  dwg->header.codepage, dash, "LTYPE_dash", "text", "");
            }
          if (!texts[cursor]
              || !checked_string_layout (
                  &string_cursor, texts[cursor],
                  &references[cursor * 2],
                  &references[cursor * 2 + 1]))
            {
              set_error (
                  writer,
                  "linetype dash string table exceeds its limits");
              goto done;
            }
        }
    }
  if (cursor != count)
    {
      set_error (writer, "linetype dash count changed while writing");
      goto done;
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE + count * LINETYPE_DASH_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)count)
      || !write_u32 (writer, LINETYPE_DASH_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    goto done;
  cursor = 0;
  for (linetype_index = 0;
       linetype_index < tables->linetype_count; linetype_index++)
    {
      Dwg_Object_LTYPE *linetype
          = tables->linetypes[linetype_index].object->tio.object->tio.LTYPE;
      size_t dash_count;
      size_t dash_index;
      if (!serialized_linetype_dash_count (
              dwg, linetype, &dash_count))
        {
          set_error (writer, "linetype dash data is invalid");
          goto done;
        }
      for (dash_index = 0; dash_index < dash_count;
           dash_index++, cursor++)
        {
          Dwg_LTYPE_dash *dash
              = dwg->header.version < R_13b1
                    ? NULL
                    : &linetype->dashes[dash_index];
          uint32_t style_index
              = dash ? find_handle_index (
                           tables->text_style_indices,
                           tables->text_style_count,
                           reference_handle (dash->style))
                     : UINT32_MAX;
          double length
              = dash ? dash->length : linetype->dashes_r11[dash_index];
          double x_offset = dash ? dash->x_offset : 0.0;
          double y_offset = dash ? dash->y_offset : 0.0;
          double scale = dash ? dash->scale : 1.0;
          double rotation = dash ? dash->rotation : 0.0;
          uint32_t shape_flag = dash ? (uint32_t)dash->shape_flag : 0u;
          int32_t shape_code
              = dash ? (int32_t)dash->complex_shapecode : 0;
          if (!isfinite (length))
            length = 0.0;
          if (!isfinite (x_offset))
            x_offset = 0.0;
          if (!isfinite (y_offset))
            y_offset = 0.0;
          if (!isfinite (scale))
            scale = 1.0;
          if (!isfinite (rotation))
            rotation = 0.0;
          if (!write_u32 (writer, tables->linetypes[linetype_index].code)
              || !write_u32 (writer, shape_flag)
              || !write_f64 (writer, length)
              || !write_i32 (writer, shape_code)
              || !write_u32 (writer, style_index)
              || !write_f64 (writer, x_offset)
              || !write_f64 (writer, y_offset)
              || !write_f64 (writer, scale)
              || !write_f64 (writer, rotation)
              || !write_u32 (writer, references[cursor * 2])
              || !write_u32 (writer, references[cursor * 2 + 1])
              || !write_u64 (writer, 0))
            goto done;
        }
    }
  for (cursor = 0; cursor < count; cursor++)
    if (!write_bytes (writer, texts[cursor], strlen (texts[cursor])))
      goto done;
  success = finish_variable_section (
      writer, entry, SECTION_LINETYPE_DASHES,
      LINETYPE_DASH_RECORD_SIZE, "linetype_dashes", offset, count,
      SECTION_FLAG_STRING_TABLE);

done:
  if (texts)
    for (cursor = 0; cursor < count; cursor++)
      free (texts[cursor]);
  free (texts);
  free (references);
  return success;
}

static int
is_layout_object (const Dwg_Object *object)
{
  return object && object->fixedtype == DWG_TYPE_LAYOUT
         && object->tio.object && object->tio.object->tio.LAYOUT;
}

static int
read_layout_annotation_all_visible (CacheWriter *writer,
                                    const Dwg_Data *dwg,
                                    const Dwg_Object *object,
                                    int *present, uint16_t *result)
{
  const Dwg_Object_Object *common;
  int in_target = 0;
  int target_seen = 0;
  int value_seen = 0;
  size_t index;
  if (!writer || !dwg || !object || !present || !result
      || !(common = object->tio.object))
    return 0;
  *present = 0;
  *result = 0u;
  if (common->num_eed > 0u && !common->eed)
    {
      set_error (writer, "LAYOUT application data is incomplete");
      return 0;
    }
  for (index = 0; index < (size_t)common->num_eed; index++)
    {
      const Dwg_Eed *eed = &common->eed[index];
      if (eed->handle.value)
        {
          Dwg_Object *appid_object;
          Dwg_Object_APPID *appid;
          char *name;
          if (in_target && !value_seen)
            {
              set_error (writer,
                         "AcadAnnoAV LAYOUT data has no boolean value");
              return 0;
            }
          in_target = 0;
          appid_object = dwg_resolve_handle_silent (
              dwg, (BITCODE_HV)eed->handle.value);
          if (!appid_object || appid_object->fixedtype != DWG_TYPE_APPID
              || !appid_object->tio.object
              || !(appid = appid_object->tio.object->tio.APPID))
            continue;
          name = copy_utf8_field (
              dwg->header.codepage, appid, "APPID", "name", "");
          if (!name)
            {
              set_error (writer,
                         "cannot read LAYOUT application identifier");
              return 0;
            }
          in_target = ascii_case_equal (name, "AcadAnnoAV");
          free (name);
          if (in_target)
            {
              if (target_seen)
                {
                  set_error (writer,
                             "LAYOUT contains duplicate AcadAnnoAV data");
                  return 0;
                }
              target_seen = 1;
              value_seen = 0;
            }
        }
      if (!in_target || !eed->data)
        continue;
      if (eed->data->code != 70u || value_seen
          || (uint16_t)eed->data->u.eed_70.rs > 1u)
        {
          set_error (writer,
                     "AcadAnnoAV LAYOUT data is not one boolean value");
          return 0;
        }
      *result = (uint16_t)eed->data->u.eed_70.rs;
      value_seen = 1;
    }
  if (in_target && !value_seen)
    {
      set_error (writer, "AcadAnnoAV LAYOUT data has no boolean value");
      return 0;
    }
  *present = target_seen;
  return 1;
}

static int
is_viewport_entity (const Dwg_Object *object)
{
  return object && object->fixedtype == DWG_TYPE_VIEWPORT
         && object->tio.entity && object->tio.entity->tio.VIEWPORT;
}

static uint64_t
viewport_count_for_owner (const Dwg_Data *dwg,
                          const CacheTables *tables,
                          uint64_t owner_handle)
{
  uint64_t count = 0;
  size_t index;
  for (index = 0; index < (size_t)dwg->num_objects; index++)
    if (is_viewport_entity (&dwg->object[index])
        && entity_owner_handle (dwg->object[index].tio.entity, tables)
               == owner_handle)
      count++;
  return count;
}

static uint32_t
viewport_frozen_layer_count (const Dwg_Entity_VIEWPORT *viewport,
                             const CacheTables *tables)
{
  uint32_t count = 0;
  size_t index;
  if (!viewport || !viewport->frozen_layers
      || viewport->num_frozen_layers <= 0)
    return 0;
  for (index = 0; index < (size_t)viewport->num_frozen_layers; index++)
    if (find_handle_index (
            tables->layer_indices, tables->layer_count,
            reference_handle (viewport->frozen_layers[index]))
        != UINT32_MAX)
      count++;
  return count;
}

static double
finite_or_zero (double value)
{
  return isfinite (value) ? value : 0.0;
}

static int
write_layout_section (CacheWriter *writer, const Dwg_Data *dwg,
                      const CacheTables *tables, SectionEntry *entry)
{
  uint64_t layout_count = 0;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint64_t first_viewport = 0;
  uint64_t offset;
  uint32_t *references = NULL;
  char **strings = NULL;
  uint64_t row = 0;
  size_t object_index;
  int success = 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    if (is_layout_object (&dwg->object[object_index]))
      layout_count++;
  if (layout_count > UINT32_MAX
      || layout_count > SIZE_MAX / (4 * sizeof (char *))
      || layout_count > SIZE_MAX / (8 * sizeof (uint32_t)))
    {
      set_error (writer, "layout table exceeds its limits");
      return 0;
    }
  if (layout_count)
    {
      strings = (char **)calloc ((size_t)layout_count * 4, sizeof (char *));
      references = (uint32_t *)malloc (
          (size_t)layout_count * 8 * sizeof (uint32_t));
      if (!strings || !references)
        {
          set_error (writer, "out of memory while writing layout table");
          goto done;
        }
    }
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      Dwg_Object *object = &dwg->object[object_index];
      Dwg_Object_LAYOUT *layout;
      size_t string_index;
      if (!is_layout_object (object))
        continue;
      layout = object->tio.object->tio.LAYOUT;
      strings[row * 4]
          = copy_utf8_field (dwg->header.codepage, layout, "LAYOUT",
                             "layout_name", "");
      strings[row * 4 + 1]
          = copy_versioned_text (
              dwg->header.codepage, dwg->header.version,
              layout->plotsettings.stylesheet);
      strings[row * 4 + 2]
          = copy_versioned_text (
              dwg->header.codepage, dwg->header.version,
              layout->plotsettings.canonical_media_name);
      strings[row * 4 + 3]
          = copy_versioned_text (
              dwg->header.codepage, dwg->header.version,
              layout->plotsettings.printer_cfg_file);
      for (string_index = 0; string_index < 4; string_index++)
        if (!strings[row * 4 + string_index]
            || !checked_string_layout (
                &string_cursor, strings[row * 4 + string_index],
                &references[row * 8 + string_index * 2],
                &references[row * 8 + string_index * 2 + 1]))
          {
            set_error (writer, "layout string table exceeds its limits");
            goto done;
          }
      row++;
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE + layout_count * LAYOUT_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)layout_count)
      || !write_u32 (writer, LAYOUT_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    goto done;
  row = 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      Dwg_Object *object = &dwg->object[object_index];
      Dwg_Object_LAYOUT *layout;
      Dwg_Object_PLOTSETTINGS *plot;
      uint64_t block_handle;
      uint64_t viewport_count;
      uint16_t annotation_all_visible;
      uint16_t layout_annotation_all_visible;
      int has_layout_annotation_all_visible;
      if (!is_layout_object (object))
        continue;
      layout = object->tio.object->tio.LAYOUT;
      plot = &layout->plotsettings;
      block_handle = reference_handle (layout->block_header);
      if (!read_layout_annotation_all_visible (
              writer, dwg, object, &has_layout_annotation_all_visible,
              &layout_annotation_all_visible))
        goto done;
      if (block_handle == tables->model_handle)
        {
          uint32_t raw = (tables->presentation_settings >> 8) & 3u;
          annotation_all_visible = raw == 0u ? 0u : 1u;
        }
      else
        annotation_all_visible
            = has_layout_annotation_all_visible
                  ? layout_annotation_all_visible
                  : 1u;
      viewport_count
          = viewport_count_for_owner (dwg, tables, block_handle);
      if (viewport_count > UINT32_MAX
          || UINT64_MAX - first_viewport < viewport_count)
        {
          set_error (writer, "layout viewport range exceeds its limits");
          goto done;
        }
      if (!write_u64 (writer, (uint64_t)object->handle.value)
          || !write_u64 (writer, block_handle)
          || !write_u64 (
              writer, reference_handle (layout->active_viewport))
          || !write_u64 (writer, first_viewport)
          || !write_u32 (writer, (uint32_t)viewport_count)
          || !write_u16 (writer, (uint16_t)layout->tab_order)
          || !write_u16 (writer, (uint16_t)layout->layout_flags)
          || !write_u32 (writer, (uint32_t)plot->plot_flags)
          || !write_u16 (
              writer, (uint16_t)plot->plot_paper_unit)
          || !write_u16 (
              writer, (uint16_t)plot->plot_rotation_mode)
          || !write_u16 (writer, (uint16_t)plot->plot_type)
          || !write_u16 (
              writer, (uint16_t)plot->std_scale_type)
          || !write_u16 (
              writer, (uint16_t)plot->shadeplot_type)
          || !write_u16 (writer, annotation_all_visible)
          || !write_f64 (
              writer, finite_or_zero (plot->std_scale_factor))
          || !write_f64 (
              writer, finite_or_zero (plot->paper_units))
          || !write_f64 (
              writer, finite_or_zero (plot->drawing_units))
          || !write_f64 (
              writer, finite_or_zero (plot->paper_width))
          || !write_f64 (
              writer, finite_or_zero (plot->paper_height))
          || !write_f64 (
              writer, finite_or_zero (plot->left_margin))
          || !write_f64 (
              writer, finite_or_zero (plot->bottom_margin))
          || !write_f64 (
              writer, finite_or_zero (plot->right_margin))
          || !write_f64 (
              writer, finite_or_zero (plot->top_margin))
          || !write_f64 (
              writer, finite_or_zero (plot->plot_origin.x))
          || !write_f64 (
              writer, finite_or_zero (plot->plot_origin.y))
          || !write_f64 (writer, finite_or_zero (layout->LIMMIN.x))
          || !write_f64 (writer, finite_or_zero (layout->LIMMIN.y))
          || !write_f64 (writer, finite_or_zero (layout->LIMMAX.x))
          || !write_f64 (writer, finite_or_zero (layout->LIMMAX.y))
          || !write_f64 (writer, finite_or_zero (layout->EXTMIN.x))
          || !write_f64 (writer, finite_or_zero (layout->EXTMIN.y))
          || !write_f64 (writer, finite_or_zero (layout->EXTMIN.z))
          || !write_f64 (writer, finite_or_zero (layout->EXTMAX.x))
          || !write_f64 (writer, finite_or_zero (layout->EXTMAX.y))
          || !write_f64 (writer, finite_or_zero (layout->EXTMAX.z)))
        goto done;
      for (size_t reference_index = 0; reference_index < 8;
           reference_index++)
        if (!write_u32 (
                writer, references[row * 8 + reference_index]))
          goto done;
      first_viewport += viewport_count;
      row++;
    }
  for (row = 0; row < layout_count * 4; row++)
    if (!write_bytes (writer, strings[row], strlen (strings[row])))
      goto done;
  success = finish_variable_section (
      writer, entry, SECTION_LAYOUTS, LAYOUT_RECORD_SIZE, "layouts",
      offset, layout_count, SECTION_FLAG_STRING_TABLE);

done:
  if (strings)
    for (row = 0; row < layout_count * 4; row++)
      free (strings[row]);
  free (strings);
  free (references);
  return success;
}

static int
write_viewport_section (CacheWriter *writer, const Dwg_Data *dwg,
                        const CacheTables *tables, SectionEntry *entry)
{
  uint64_t viewport_count = 0;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint64_t first_frozen_layer = 0;
  uint64_t first_clip_vertex = 0;
  uint64_t offset;
  uint32_t *references = NULL;
  char **strings = NULL;
  uint64_t row = 0;
  size_t layout_index;
  int success = 0;
  for (layout_index = 0; layout_index < (size_t)dwg->num_objects;
       layout_index++)
    if (is_layout_object (&dwg->object[layout_index]))
      viewport_count += viewport_count_for_owner (
          dwg, tables,
          reference_handle (
              dwg->object[layout_index].tio.object->tio.LAYOUT
                  ->block_header));
  if (viewport_count > UINT32_MAX
      || viewport_count > SIZE_MAX / sizeof (char *)
      || viewport_count > SIZE_MAX / (2 * sizeof (uint32_t)))
    {
      set_error (writer, "viewport table exceeds its limits");
      return 0;
    }
  if (viewport_count)
    {
      strings = (char **)calloc ((size_t)viewport_count, sizeof (char *));
      references = (uint32_t *)malloc (
          (size_t)viewport_count * 2 * sizeof (uint32_t));
      if (!strings || !references)
        {
          set_error (writer, "out of memory while writing viewport table");
          goto done;
        }
    }
  for (layout_index = 0; layout_index < (size_t)dwg->num_objects;
       layout_index++)
    {
      Dwg_Object *layout_object = &dwg->object[layout_index];
      uint64_t block_handle;
      size_t object_index;
      if (!is_layout_object (layout_object))
        continue;
      block_handle = reference_handle (
          layout_object->tio.object->tio.LAYOUT->block_header);
      for (object_index = 0; object_index < (size_t)dwg->num_objects;
           object_index++)
        {
          Dwg_Object *object = &dwg->object[object_index];
          Dwg_Entity_VIEWPORT *viewport;
          if (!is_viewport_entity (object)
              || entity_owner_handle (object->tio.entity, tables)
                     != block_handle)
            continue;
          viewport = object->tio.entity->tio.VIEWPORT;
          if (row >= viewport_count || !strings || !references)
            {
              set_error (writer, "viewport count changed while writing");
              goto done;
            }
          strings[row] = copy_versioned_text (
              dwg->header.codepage, dwg->header.version,
              viewport->style_sheet);
          if (!strings[row]
              || !checked_string_layout (
                  &string_cursor, strings[row], &references[row * 2],
                  &references[row * 2 + 1]))
            {
              set_error (
                  writer, "viewport string table exceeds its limits");
              goto done;
            }
          row++;
        }
    }
  if (row != viewport_count)
    {
      set_error (writer, "viewport count changed while writing");
      goto done;
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE
        + viewport_count * VIEWPORT_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)viewport_count)
      || !write_u32 (writer, VIEWPORT_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    goto done;
  row = 0;
  for (layout_index = 0; layout_index < (size_t)dwg->num_objects;
       layout_index++)
    {
      Dwg_Object *layout_object = &dwg->object[layout_index];
      uint64_t block_handle;
      size_t object_index;
      if (!is_layout_object (layout_object))
        continue;
      block_handle = reference_handle (
          layout_object->tio.object->tio.LAYOUT->block_header);
      for (object_index = 0; object_index < (size_t)dwg->num_objects;
           object_index++)
        {
          Dwg_Object *object = &dwg->object[object_index];
          Dwg_Object_Entity *entity;
          Dwg_Entity_VIEWPORT *viewport;
          uint32_t frozen_count;
          uint32_t clip_vertex_count;
          uint32_t flags;
          if (!is_viewport_entity (object)
              || entity_owner_handle (object->tio.entity, tables)
                     != block_handle)
            continue;
          entity = object->tio.entity;
          viewport = entity->tio.VIEWPORT;
          if (row >= viewport_count || !references)
            {
              set_error (writer, "viewport count changed while writing");
              goto done;
            }
          frozen_count
              = viewport_frozen_layer_count (viewport, tables);
          clip_vertex_count
              = viewport_clip_vertex_count (dwg, tables, viewport);
          if (clip_vertex_count
                  > MAX_VIEWPORT_CLIP_VERTICES_PER_BOUNDARY
              || first_clip_vertex
                     > MAX_VIEWPORT_CLIP_VERTICES
                           - clip_vertex_count)
            {
              set_error (
                  writer, "viewport clip vertex pool exceeds its limits");
              goto done;
            }
          flags = (entity->invisible ? 1u : 0u)
                  | (viewport->ucs_at_origin ? 2u : 0u)
                  | (viewport->UCSVP ? 4u : 0u)
                  | (viewport->use_default_lights ? 8u : 0u);
          if (!write_u64 (writer, (uint64_t)object->handle.value)
              || !write_u64 (writer, block_handle)
              || !write_u32 (
                  writer, entity_layer_index (entity, tables))
              || !write_u32 (
                  writer, encode_entity_color (&entity->color))
              || !write_u64 (writer, first_frozen_layer)
              || !write_u32 (writer, frozen_count)
              || !write_u32 (
                  writer, (uint32_t)viewport->status_flag)
              || !write_i16 (writer, (int16_t)viewport->on_off)
              || !write_i16 (writer, (int16_t)viewport->id)
              || !write_u32 (writer, flags)
              || !write_f64 (
                  writer, finite_or_zero (viewport->center.x))
              || !write_f64 (
                  writer, finite_or_zero (viewport->center.y))
              || !write_f64 (
                  writer, finite_or_zero (viewport->center.z))
              || !write_f64 (
                  writer, finite_or_zero (viewport->width))
              || !write_f64 (
                  writer, finite_or_zero (viewport->height))
              || !write_f64 (
                  writer, finite_or_zero (viewport->view_target.x))
              || !write_f64 (
                  writer, finite_or_zero (viewport->view_target.y))
              || !write_f64 (
                  writer, finite_or_zero (viewport->view_target.z))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWDIR.x))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWDIR.y))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWDIR.z))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWTWIST))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWSIZE))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWCTR.x))
              || !write_f64 (
                  writer, finite_or_zero (viewport->VIEWCTR.y))
              || !write_f64 (
                  writer, finite_or_zero (viewport->LENSLENGTH))
              || !write_f64 (
                  writer, finite_or_zero (viewport->FRONTZ))
              || !write_f64 (
                  writer, finite_or_zero (viewport->BACKZ))
              || !write_f64 (
                  writer, finite_or_zero (viewport->brightness))
              || !write_f64 (
                  writer, finite_or_zero (viewport->contrast))
              || !write_u32 (
                  writer, encode_color (&viewport->ambient_color))
              || !write_u16 (
                  writer, (uint16_t)viewport->render_mode)
              || !write_u16 (
                  writer, (uint16_t)viewport->shadeplot_mode)
              || !write_u64 (
                  writer, reference_handle (viewport->clip_boundary))
              || !write_u64 (
                  writer, reference_handle (viewport->visualstyle))
              || !write_u64 (
                  writer, reference_handle (viewport->background))
              || !write_u32 (writer, references[row * 2])
              || !write_u32 (writer, references[row * 2 + 1])
              || !write_u64 (writer, first_clip_vertex)
              || !write_u32 (writer, clip_vertex_count)
              || !write_u32 (writer, 0)
              || !write_f64 (
                  writer, viewport_annotation_scale (dwg, object)))
            goto done;
          first_frozen_layer += frozen_count;
          first_clip_vertex += clip_vertex_count;
          row++;
        }
    }
  if (row != viewport_count)
    {
      set_error (writer, "viewport count changed while writing");
      goto done;
    }
  for (row = 0; row < viewport_count; row++)
    if (!write_bytes (writer, strings[row], strlen (strings[row])))
      goto done;
  success = finish_variable_section (
      writer, entry, SECTION_VIEWPORTS, VIEWPORT_RECORD_SIZE,
      "viewports", offset, viewport_count, SECTION_FLAG_STRING_TABLE);

done:
  if (strings)
    for (row = 0; row < viewport_count; row++)
      free (strings[row]);
  free (strings);
  free (references);
  return success;
}

static int
write_viewport_frozen_layer_section (
    CacheWriter *writer, const Dwg_Data *dwg,
    const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t layout_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (layout_index = 0; layout_index < (size_t)dwg->num_objects;
       layout_index++)
    {
      Dwg_Object *layout_object = &dwg->object[layout_index];
      uint64_t block_handle;
      size_t object_index;
      if (!is_layout_object (layout_object))
        continue;
      block_handle = reference_handle (
          layout_object->tio.object->tio.LAYOUT->block_header);
      for (object_index = 0; object_index < (size_t)dwg->num_objects;
           object_index++)
        {
          Dwg_Object *object = &dwg->object[object_index];
          Dwg_Entity_VIEWPORT *viewport;
          size_t frozen_index;
          if (!is_viewport_entity (object)
              || entity_owner_handle (object->tio.entity, tables)
                     != block_handle)
            continue;
          viewport = object->tio.entity->tio.VIEWPORT;
          if (!viewport->frozen_layers
              || viewport->num_frozen_layers <= 0)
            continue;
          for (frozen_index = 0;
               frozen_index < (size_t)viewport->num_frozen_layers;
               frozen_index++)
            {
              uint32_t layer_index = find_handle_index (
                  tables->layer_indices, tables->layer_count,
                  reference_handle (
                      viewport->frozen_layers[frozen_index]));
              if (layer_index == UINT32_MAX)
                continue;
              if (!write_u32 (writer, layer_index)
                  || !write_u32 (writer, 0))
                return 0;
              count++;
            }
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_VIEWPORT_FROZEN_LAYERS,
      VIEWPORT_FROZEN_LAYER_RECORD_SIZE,
      "viewport_frozen_layers", offset, count);
}

static int
viewport_layer_override_value (
    const CacheTables *tables, uint16_t property,
    const Dwg_Resbuf *item, uint32_t *value)
{
  uint32_t raw;
  if (!tables || !item || !value)
    return 0;
  if (property == VIEWPORT_LAYER_OVERRIDE_COLOR)
    {
      uint32_t method;
      raw = (uint32_t)item->value.i32;
      method = raw >> 24;
      if (method == 0xc2u)
        *value = (3u << 30) | (raw & 0x00ffffffu);
      else if (method == 0xc3u && (raw & 0xffu) > 0u)
        *value = (2u << 30) | (raw & 0xffu);
      else
        return 0;
      return 1;
    }
  if (property == VIEWPORT_LAYER_OVERRIDE_TRANSPARENCY)
    {
      uint32_t alpha;
      uint32_t code;
      raw = (uint32_t)item->value.i32;
      if ((raw >> 24) != 2u)
        return 0;
      alpha = raw & 0xffu;
      code = 3u + (alpha * 60u + 127u) / 255u;
      *value = code << 24;
      return 1;
    }
  if (property == VIEWPORT_LAYER_OVERRIDE_LINETYPE)
    {
      uint32_t code = find_handle_index (
          tables->linetype_codes, tables->linetype_code_count,
          (uint64_t)item->value.absref);
      if (code == UINT32_MAX || code > 2047u)
        return 0;
      *value = code;
      return 1;
    }
  if (property == VIEWPORT_LAYER_OVERRIDE_LINEWEIGHT)
    {
      int32_t lineweight = item->value.i32;
      if (lineweight < 0 || lineweight > 211)
        return 0;
      *value = (uint32_t)lineweight;
      return 1;
    }
  return 0;
}

static int
write_viewport_layer_override_section (
    CacheWriter *writer, const Dwg_Data *dwg,
    const CacheTables *tables, SectionEntry *entry)
{
  static const struct
  {
    const char *key;
    short value_type;
    uint16_t property;
  } definitions[] = {
    { "ADSK_XREC_LAYER_COLOR_OVR", 420,
      VIEWPORT_LAYER_OVERRIDE_COLOR },
    { "ADSK_XREC_LAYER_ALPHA_OVR", 440,
      VIEWPORT_LAYER_OVERRIDE_TRANSPARENCY },
    { "ADSK_XREC_LAYER_LINETYPE_OVR", 343,
      VIEWPORT_LAYER_OVERRIDE_LINETYPE },
    { "ADSK_XREC_LAYER_LINEWT_OVR", 91,
      VIEWPORT_LAYER_OVERRIDE_LINEWEIGHT },
  };
  uint64_t offset;
  uint64_t count = 0;
  size_t layer_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (layer_index = 0; layer_index < tables->layer_count; layer_index++)
    {
      Dwg_Object *layer_object = tables->layers[layer_index].object;
      Dwg_Object *xdic;
      size_t definition_index;
      if (!layer_object || !layer_object->tio.object
          || !layer_object->tio.object->xdicobjhandle)
        continue;
      xdic = reference_object (
          dwg, layer_object->tio.object->xdicobjhandle);
      for (definition_index = 0;
           definition_index
               < sizeof (definitions) / sizeof (definitions[0]);
           definition_index++)
        {
          Dwg_Object *xrecord_object = dictionary_item_named (
              dwg, xdic, definitions[definition_index].key);
          Dwg_Object_XRECORD *xrecord;
          Dwg_Resbuf *item;
          uint64_t viewport_handle = 0;
          if (!xrecord_object
              || xrecord_object->fixedtype != DWG_TYPE_XRECORD
              || !xrecord_object->tio.object
              || !(xrecord
                       = xrecord_object->tio.object->tio.XRECORD))
            continue;
          for (item = xrecord->xdata; item; item = item->nextrb)
            {
              uint32_t value;
              Dwg_Object *viewport_object;
              if (item->type == 335)
                {
                  viewport_handle = (uint64_t)item->value.absref;
                  continue;
                }
              if (item->type != definitions[definition_index].value_type
                  || !viewport_handle)
                continue;
              viewport_object = dwg_resolve_handle_silent (
                  dwg, viewport_handle);
              if (is_viewport_entity (viewport_object)
                  && viewport_layer_override_value (
                      tables, definitions[definition_index].property,
                      item, &value))
                {
                  if (count >= MAX_VIEWPORT_LAYER_OVERRIDES)
                    {
                      set_error (
                          writer,
                          "viewport layer overrides exceed their limits");
                      return 0;
                    }
                  if (!write_u64 (writer, viewport_handle)
                      || !write_u32 (writer, (uint32_t)layer_index)
                      || !write_u16 (
                          writer,
                          definitions[definition_index].property)
                      || !write_u16 (writer, 0)
                      || !write_u32 (writer, value)
                      || !write_u32 (writer, 0))
                    return 0;
                  count++;
                }
              viewport_handle = 0;
            }
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_VIEWPORT_LAYER_OVERRIDES,
      VIEWPORT_LAYER_OVERRIDE_RECORD_SIZE,
      "viewport_layer_overrides", offset, count);
}

static int
is_text_source_object (const Dwg_Object *object)
{
  return object && (object->fixedtype == DWG_TYPE_TEXT
                    || object->fixedtype == DWG_TYPE_MTEXT
                    || object->fixedtype == DWG_TYPE_ATTDEF
                    || object->fixedtype == DWG_TYPE_ATTRIB
                    || (object->fixedtype == DWG_TYPE_MULTILEADER
                        && object->tio.entity
                        && object->tio.entity->tio.MULTILEADER
                        && object->tio.entity->tio.MULTILEADER
                               ->ctx.has_content_txt));
}

typedef struct
{
  uint64_t string_cursor;
  uint32_t *references;
  size_t row;
} TextStringLayoutContext;

static int
layout_text_source_strings (void *context, const TextSource *source)
{
  TextStringLayoutContext *layout
      = (TextStringLayoutContext *)context;
  size_t row = layout->row;
  if (!checked_string_layout (
          &layout->string_cursor, source->value,
          &layout->references[row * 6u],
          &layout->references[row * 6u + 1u])
      || !checked_string_layout (
          &layout->string_cursor, source->tag,
          &layout->references[row * 6u + 2u],
          &layout->references[row * 6u + 3u])
      || !checked_string_layout (
          &layout->string_cursor, source->prompt,
          &layout->references[row * 6u + 4u],
          &layout->references[row * 6u + 5u]))
    return 0;
  layout->row++;
  return 1;
}

typedef struct
{
  CacheWriter *writer;
  const CacheTables *tables;
  const uint32_t *references;
  uint64_t first_column_height;
  size_t row;
} TextRecordWriterContext;

static int
write_text_source_record (void *context, const TextSource *source)
{
  TextRecordWriterContext *records
      = (TextRecordWriterContext *)context;
  CacheWriter *writer = records->writer;
  uint32_t style_index
      = source->has_style_index_override
            ? source->style_index_override
            : find_handle_index (
                  records->tables->text_style_indices,
                  records->tables->text_style_count,
                  reference_handle (source->style));
  size_t index;
  if (UINT64_MAX - records->first_column_height
      < source->column_height_count)
    return 0;
  if (!write_text_source_common (writer, source, records->tables)
      || !write_u16 (writer, source->kind)
      || !write_u16 (writer, source->flags)
      || !write_u32 (writer, style_index))
    return 0;
  for (index = 0; index < 6u; index++)
    if (!write_u32 (
            writer, records->references[records->row * 6u + index]))
      return 0;
  if (!write_u64 (writer, source->linked_handle)
      || !write_vec3 (writer, source->insertion_point)
      || !write_vec3 (writer, source->alignment_point)
      || !write_vec3 (writer, source->normal)
      || !write_vec3 (writer, source->x_axis_direction)
      || !write_f64 (writer, source->height)
      || !write_f64 (writer, source->width_factor)
      || !write_f64 (writer, source->rotation)
      || !write_f64 (writer, source->oblique_angle)
      || !write_f64 (writer, source->thickness)
      || !write_f64 (writer, source->rectangle_width)
      || !write_f64 (writer, source->rectangle_height)
      || !write_f64 (writer, source->extents_width)
      || !write_f64 (writer, source->extents_height)
      || !write_f64 (writer, source->line_spacing_factor)
      || !write_f64 (writer, source->background_scale)
      || !write_u32 (writer, source->background_color)
      || !write_i32 (writer, source->background_transparency)
      || !write_i32 (writer, source->background_flags)
      || !write_i32 (writer, source->source_flags)
      || !write_i16 (writer, source->horizontal_alignment)
      || !write_i16 (writer, source->vertical_alignment)
      || !write_i16 (writer, source->attachment)
      || !write_i16 (writer, source->flow_direction)
      || !write_i16 (writer, source->line_spacing_style)
      || !write_i16 (writer, source->generation_flags)
      || !write_i16 (writer, source->field_length)
      || !write_i16 (writer, source->mtext_type)
      || !write_i32 (writer, source->line_count)
      || !write_i32 (writer, source->column_type)
      || !write_i32 (writer, source->column_count)
      || !write_u32 (writer, source->column_flags)
      || !write_f64 (writer, source->column_width)
      || !write_f64 (writer, source->column_gutter)
      || !write_u64 (writer, records->first_column_height)
      || !write_u64 (writer, source->column_height_count))
    return 0;
  records->first_column_height += source->column_height_count;
  records->row++;
  return 1;
}

static int
write_text_source_strings (void *context, const TextSource *source)
{
  CacheWriter *writer = (CacheWriter *)context;
  return write_bytes (writer, source->value, strlen (source->value))
         && write_bytes (writer, source->tag, strlen (source->tag))
         && write_bytes (
             writer, source->prompt, strlen (source->prompt));
}

static int
write_text_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                           const CacheTables *tables, SectionEntry *entry)
{
  TextStringLayoutContext layout;
  TextRecordWriterContext records;
  uint64_t offset;
  uint64_t text_count;
  uint64_t string_offset;
  uint32_t *references = NULL;
  int success = 0;
  if (!scene_text_source_count (dwg, tables, &text_count))
    {
      set_error (writer, "cannot count source or proxy text");
      return 0;
    }
  if (text_count > SIZE_MAX / (6u * sizeof (uint32_t))
      || text_count > UINT32_MAX)
    {
      set_error (writer, "too many text entities for scene cache");
      goto done;
    }
  references
      = text_count
            ? (uint32_t *)malloc ((size_t)text_count * 6u
                                 * sizeof (uint32_t))
            : NULL;
  if (text_count && !references)
    {
      set_error (writer, "out of memory while writing source text");
      goto done;
    }
  memset (&layout, 0, sizeof (layout));
  layout.references = references;
  if (!for_each_scene_text_source (
          dwg, tables, layout_text_source_strings, &layout)
      || layout.row != (size_t)text_count)
    {
      set_error (writer, "text string table exceeds its limits");
      goto done;
    }

  string_offset
      = STRING_TABLE_HEADER_SIZE
        + text_count * TEXT_ENTITY_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)text_count)
      || !write_u32 (writer, TEXT_ENTITY_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    goto done;
  memset (&records, 0, sizeof (records));
  records.writer = writer;
  records.tables = tables;
  records.references = references;
  if (!for_each_scene_text_source (
          dwg, tables, write_text_source_record, &records)
      || records.row != (size_t)text_count)
    {
      if (!writer->failed)
        set_error (writer, "cannot serialize source or proxy text");
      goto done;
    }
  if (!for_each_scene_text_source (
          dwg, tables, write_text_source_strings, writer))
    {
      if (!writer->failed)
        set_error (writer, "cannot serialize source or proxy text strings");
      goto done;
    }
  success = finish_variable_section (
      writer, entry, SECTION_TEXT_ENTITIES, TEXT_ENTITY_RECORD_SIZE,
      "text_entities", offset, text_count,
      SECTION_FLAG_STRING_TABLE);

done:
  free (references);
  return success;
}

static int
write_text_column_height_section (CacheWriter *writer, const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      TextSource source;
      uint64_t column_index;
      if (!is_text_source_object (&dwg->object[i]))
        continue;
      if (!read_text_source (dwg, &dwg->object[i], &source))
        {
          set_error (writer, "cannot decode source text as UTF-8");
          return 0;
        }
      for (column_index = 0;
           column_index < source.column_height_count; column_index++)
        {
          if (!write_f64 (writer, source.column_heights[column_index]))
            {
              free_text_source (&source);
              return 0;
            }
          count++;
        }
      free_text_source (&source);
    }
  return finish_fixed_section (
      writer, entry, SECTION_TEXT_COLUMN_HEIGHTS,
      TEXT_COLUMN_HEIGHT_RECORD_SIZE, "text_column_heights", offset, count);
}

static int
write_text_annotation_context_section (CacheWriter *writer,
                                       const Dwg_Data *dwg,
                                       SectionEntry *entry)
{
  uint64_t offset;
  uint64_t context_count = 0;
  uint64_t first_column_height = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      Dwg_Object *text_object = &dwg->object[object_index];
      Dwg_Object_DICTIONARY *dictionary;
      uint32_t context_index;
      if (!is_supported_text_annotation_owner (text_object))
        continue;
      dictionary = text_annotation_context_dictionary (dwg, text_object);
      if (!dictionary || dictionary->numitems <= 0
          || !dictionary->itemhandles)
        continue;
      for (context_index = 0;
           context_index < (uint32_t)dictionary->numitems;
           context_index++)
        {
          Dwg_Object *context_object = reference_object (
              dwg, dictionary->itemhandles[context_index]);
          if (text_object->fixedtype == DWG_TYPE_MTEXT)
            {
              const Dwg_Object_MTEXTOBJECTCONTEXTDATA *context;
              double scale;
              uint32_t flags;
              if (!valid_mtext_annotation_context (
                      dwg, context_object, &context, &scale))
                continue;
              if (context_count >= MAX_TEXT_ANNOTATION_CONTEXTS
                  || first_column_height
                         > MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS
                               - context->num_column_heights)
                {
                  set_error (
                      writer,
                      "text annotation context pool exceeds its limits");
                  return 0;
                }
              flags = (context->is_default ? 1u : 0u)
                      | (context->auto_height ? 2u : 0u)
                      | (context->flow_reversed ? 4u : 0u);
              if (!write_u64 (
                      writer, (uint64_t)text_object->handle.value)
                  || !write_f64 (writer, scale)
                  || !write_u32 (writer, flags)
                  || !write_i32 (writer, (int32_t)context->attachment)
                  || !write_f64 (writer, context->ins_pt.x)
                  || !write_f64 (writer, context->ins_pt.y)
                  || !write_f64 (writer, context->ins_pt.z)
                  || !write_f64 (writer, context->x_axis_dir.x)
                  || !write_f64 (writer, context->x_axis_dir.y)
                  || !write_f64 (writer, context->x_axis_dir.z)
                  || !write_f64 (writer, context->rect_height)
                  || !write_f64 (writer, context->rect_width)
                  || !write_f64 (writer, context->extents_width)
                  || !write_f64 (writer, context->extents_height)
                  || !write_i32 (
                      writer, (int32_t)context->column_type)
                  || !write_u32 (writer, 0)
                  || !write_f64 (writer, context->column_width)
                  || !write_f64 (writer, context->gutter)
                  || !write_u64 (writer, first_column_height)
                  || !write_u64 (
                      writer, (uint64_t)context->num_column_heights)
                  || !write_u64 (writer, 0)
                  || !write_u64 (writer, 0))
                return 0;
              first_column_height += context->num_column_heights;
            }
          else
            {
              TextAnnotationContext context;
              uint32_t flags;
              if (!valid_text_annotation_context (
                      dwg, text_object, context_object, &context))
                continue;
              if (context_count >= MAX_TEXT_ANNOTATION_CONTEXTS)
                {
                  set_error (
                      writer,
                      "text annotation context pool exceeds its limits");
                  return 0;
                }
              flags = (context.is_default ? 1u : 0u) | (1u << 3);
              if (!write_u64 (
                      writer, (uint64_t)text_object->handle.value)
                  || !write_f64 (writer, context.scale)
                  || !write_u32 (writer, flags)
                  || !write_i32 (writer, context.horizontal_mode)
                  || !write_vec3 (writer, context.insertion_point)
                  || !write_vec3 (writer, context.alignment_point)
                  || !write_f64 (writer, context.rotation)
                  || !write_f64 (writer, 0.0)
                  || !write_f64 (writer, 0.0)
                  || !write_f64 (writer, 0.0)
                  || !write_i32 (writer, 0)
                  || !write_u32 (writer, 0)
                  || !write_f64 (writer, 0.0)
                  || !write_f64 (writer, 0.0)
                  || !write_u64 (writer, first_column_height)
                  || !write_u64 (writer, 0)
                  || !write_u64 (writer, 0)
                  || !write_u64 (writer, 0))
                return 0;
            }
          context_count++;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_TEXT_ANNOTATION_CONTEXTS,
      TEXT_ANNOTATION_CONTEXT_RECORD_SIZE, "text_annotation_contexts",
      offset, context_count);
}

static int
write_text_annotation_column_height_section (
    CacheWriter *writer, const Dwg_Data *dwg, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      Dwg_Object *text_object = &dwg->object[object_index];
      Dwg_Object_DICTIONARY *dictionary;
      uint32_t context_index;
      if (text_object->fixedtype != DWG_TYPE_MTEXT)
        continue;
      dictionary = text_annotation_context_dictionary (dwg, text_object);
      if (!dictionary || dictionary->numitems <= 0
          || !dictionary->itemhandles)
        continue;
      for (context_index = 0;
           context_index < (uint32_t)dictionary->numitems;
           context_index++)
        {
          const Dwg_Object_MTEXTOBJECTCONTEXTDATA *context;
          uint32_t column_index;
          if (!valid_mtext_annotation_context (
                  dwg,
                  reference_object (
                      dwg, dictionary->itemhandles[context_index]),
                  &context, NULL))
            continue;
          if (count
              > MAX_TEXT_ANNOTATION_COLUMN_HEIGHTS
                    - context->num_column_heights)
            {
              set_error (
                  writer,
                  "text annotation column-height pool exceeds its limits");
              return 0;
            }
          for (column_index = 0;
               column_index < (uint32_t)context->num_column_heights;
               column_index++)
            if (!write_f64 (writer, context->column_heights[column_index]))
              return 0;
          count += context->num_column_heights;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_TEXT_ANNOTATION_COLUMN_HEIGHTS,
      TEXT_ANNOTATION_COLUMN_HEIGHT_RECORD_SIZE,
      "text_annotation_column_heights", offset, count);
}

static int
write_line_section (CacheWriter *writer, const Dwg_Data *dwg,
                    const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_LINE *line;
      double start[3];
      double end[3];
      if (object->fixedtype != DWG_TYPE_LINE || !object->tio.entity
          || !(line = object->tio.entity->tio.LINE))
        continue;
      start[0] = line->start.x;
      start[1] = line->start.y;
      start[2] = line->start.z;
      end[0] = line->end.x;
      end[1] = line->end.y;
      end[2] = line->end.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, start) || !write_vec3 (writer, end))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_LINES,
                               LINE_RECORD_SIZE, "lines", offset, count);
}

static int
write_construction_line_section (CacheWriter *writer,
                                 const Dwg_Data *dwg,
                                 const CacheTables *tables,
                                 SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t index;
  if (!align_writer (writer, &offset))
    return 0;
  for (index = 0; index < (size_t)dwg->num_objects; index++)
    {
      const Dwg_Object *object = &dwg->object[index];
      const Dwg_Entity_RAY *line;
      double point[3];
      double direction[3];
      uint16_t type_flag;
      if (!object->tio.entity)
        continue;
      if (object->fixedtype == DWG_TYPE_XLINE)
        {
          line = object->tio.entity->tio.XLINE;
          type_flag = 0u;
        }
      else if (object->fixedtype == DWG_TYPE_RAY)
        {
          line = object->tio.entity->tio.RAY;
          type_flag = 1u << 1;
        }
      else
        continue;
      if (!line || !isfinite (line->point.x)
          || !isfinite (line->point.y) || !isfinite (line->point.z)
          || !isfinite (line->vector.x)
          || !isfinite (line->vector.y)
          || !isfinite (line->vector.z)
          || hypot (line->vector.x, line->vector.y) <= 1.0e-12)
        continue;
      point[0] = line->point.x;
      point[1] = line->point.y;
      point[2] = line->point.z;
      direction[0] = line->vector.x;
      direction[1] = line->vector.y;
      direction[2] = line->vector.z;
      if (!write_common_flags (
              writer, object, tables, type_flag)
          || !write_vec3 (writer, point)
          || !write_vec3 (writer, direction))
        return 0;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_CONSTRUCTION_LINES,
      CONSTRUCTION_LINE_RECORD_SIZE, "construction_lines", offset,
      count);
}

static int
write_arc_section (CacheWriter *writer, const Dwg_Data *dwg,
                   const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_ARC *arc;
      double center[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_ARC || !object->tio.entity
          || !(arc = object->tio.entity->tio.ARC))
        continue;
      center[0] = arc->center.x;
      center[1] = arc->center.y;
      center[2] = arc->center.z;
      normal[0] = arc->extrusion.x;
      normal[1] = arc->extrusion.y;
      normal[2] = arc->extrusion.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, center)
          || !write_f64 (writer, arc->radius)
          || !write_f64 (writer, arc->start_angle)
          || !write_f64 (writer, arc->end_angle)
          || !write_f64 (writer, arc->thickness)
          || !write_vec3 (writer, normal))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_ARCS, ARC_RECORD_SIZE,
                               "arcs", offset, count);
}

static int
write_circle_section (CacheWriter *writer, const Dwg_Data *dwg,
                      const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_CIRCLE *circle;
      double center[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_CIRCLE || !object->tio.entity
          || !(circle = object->tio.entity->tio.CIRCLE))
        continue;
      center[0] = circle->center.x;
      center[1] = circle->center.y;
      center[2] = circle->center.z;
      normal[0] = circle->extrusion.x;
      normal[1] = circle->extrusion.y;
      normal[2] = circle->extrusion.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, center)
          || !write_f64 (writer, circle->radius)
          || !write_f64 (writer, circle->thickness)
          || !write_vec3 (writer, normal))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_CIRCLES,
                               CIRCLE_RECORD_SIZE, "circles", offset, count);
}

static int
write_insert_record (CacheWriter *writer, const Dwg_Object *object,
                     const CacheTables *tables, const double insert_point[3],
                     const double scale[3], double rotation,
                     const double normal[3], uint64_t target_handle,
                     uint16_t columns, uint16_t rows, double column_spacing,
                     double row_spacing)
{
  uint32_t block_index
      = find_handle_index (tables->block_indices, tables->block_count,
                           target_handle);
  return write_common (writer, object, tables)
         && write_u32 (writer, block_index) && write_u16 (writer, columns)
         && write_u16 (writer, rows) && write_vec3 (writer, insert_point)
         && write_vec3 (writer, scale) && write_f64 (writer, rotation)
         && write_vec3 (writer, normal)
         && write_f64 (writer, column_spacing)
         && write_f64 (writer, row_spacing);
}

static uint16_t
bounded_u16_or_one (uint64_t value)
{
  if (value == 0)
    return 1;
  return value > UINT16_MAX ? UINT16_MAX : (uint16_t)value;
}

static int
write_insert_section (CacheWriter *writer, const Dwg_Data *dwg,
                      const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      double insert_point[3];
      double scale[3];
      double normal[3];
      if (!object->tio.entity)
        continue;
      if (object->fixedtype == DWG_TYPE_INSERT
          && object->tio.entity->tio.INSERT)
        {
          Dwg_Entity_INSERT *insert = object->tio.entity->tio.INSERT;
          insert_point[0] = insert->ins_pt.x;
          insert_point[1] = insert->ins_pt.y;
          insert_point[2] = insert->ins_pt.z;
          scale[0] = insert->scale.x;
          scale[1] = insert->scale.y;
          scale[2] = insert->scale.z;
          normal[0] = insert->extrusion.x;
          normal[1] = insert->extrusion.y;
          normal[2] = insert->extrusion.z;
          if (!write_insert_record (
                  writer, object, tables, insert_point, scale,
                  insert->rotation, normal,
                  reference_handle (insert->block_header),
                  bounded_u16_or_one (insert->num_cols),
                  bounded_u16_or_one (insert->num_rows),
                  insert->col_spacing, insert->row_spacing))
            return 0;
          count++;
        }
      else if (object->fixedtype == DWG_TYPE_MINSERT
               && object->tio.entity->tio.MINSERT)
        {
          Dwg_Entity_MINSERT *insert = object->tio.entity->tio.MINSERT;
          insert_point[0] = insert->ins_pt.x;
          insert_point[1] = insert->ins_pt.y;
          insert_point[2] = insert->ins_pt.z;
          scale[0] = insert->scale.x;
          scale[1] = insert->scale.y;
          scale[2] = insert->scale.z;
          normal[0] = insert->extrusion.x;
          normal[1] = insert->extrusion.y;
          normal[2] = insert->extrusion.z;
          if (!write_insert_record (
                  writer, object, tables, insert_point, scale,
                  insert->rotation, normal,
                  reference_handle (insert->block_header),
                  bounded_u16_or_one (insert->num_cols),
                  bounded_u16_or_one (insert->num_rows),
                  insert->col_spacing, insert->row_spacing))
            return 0;
          count++;
        }
      else if (object->fixedtype == DWG_TYPE_MULTILEADER
               && object->tio.entity->tio.MULTILEADER
               && object->tio.entity->tio.MULTILEADER->ctx.has_content_blk)
        {
          const Dwg_MLEADER_Content_Block *block
              = &object->tio.entity->tio.MULTILEADER->ctx.content.blk;
          uint64_t target_handle = reference_handle (block->block_table);
          if (find_handle_index (tables->block_indices,
                                 tables->block_count,
                                 target_handle)
              == UINT32_MAX)
            continue;
          insert_point[0] = block->location.x;
          insert_point[1] = block->location.y;
          insert_point[2] = block->location.z;
          scale[0] = block->scale.x;
          scale[1] = block->scale.y;
          scale[2] = block->scale.z;
          normal[0] = block->normal.x;
          normal[1] = block->normal.y;
          normal[2] = block->normal.z;
          if (!isfinite (block->location.x)
              || !isfinite (block->location.y)
              || !isfinite (block->location.z)
              || !isfinite (block->scale.x)
              || !isfinite (block->scale.y)
              || !isfinite (block->scale.z)
              || !isfinite (block->normal.x)
              || !isfinite (block->normal.y)
              || !isfinite (block->normal.z)
              || !isfinite (block->rotation))
            continue;
          if (!write_insert_record (
                  writer, object, tables, insert_point, scale,
                  block->rotation, normal, target_handle, 1, 1,
                  0.0, 0.0))
            return 0;
          count++;
        }
      else
        {
          uint64_t target_handle;
          if (!dimension_block_target (object, tables, &target_handle,
                                       insert_point))
            continue;
          scale[0] = 1.0;
          scale[1] = 1.0;
          scale[2] = 1.0;
          normal[0] = 0.0;
          normal[1] = 0.0;
          normal[2] = 1.0;
          if (!write_insert_record (writer, object, tables, insert_point,
                                    scale, 0.0, normal, target_handle, 1, 1,
                                    0.0, 0.0))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (writer, entry, SECTION_INSERTS,
                               INSERT_RECORD_SIZE, "inserts", offset, count);
}

static const Dwg_Object_SPATIAL_FILTER *
find_spatial_filter (const Dwg_Data *dwg, Dwg_Object *object,
                     unsigned depth)
{
  Dwg_Object_DICTIONARY *dictionary;
  uint32_t index;
  if (!object || depth > 4)
    return NULL;
  if (object->fixedtype == DWG_TYPE_SPATIAL_FILTER
      && object->tio.object
      && object->tio.object->tio.SPATIAL_FILTER)
    return object->tio.object->tio.SPATIAL_FILTER;
  if (object->fixedtype != DWG_TYPE_DICTIONARY
      || !object->tio.object
      || !(dictionary = object->tio.object->tio.DICTIONARY)
      || dictionary->numitems <= 0
      || !dictionary->itemhandles)
    return NULL;
  for (index = 0; index < (uint32_t)dictionary->numitems; index++)
    {
      const Dwg_Object_SPATIAL_FILTER *filter = find_spatial_filter (
          dwg, reference_object (dwg, dictionary->itemhandles[index]),
          depth + 1);
      if (filter)
        return filter;
    }
  return NULL;
}

static const Dwg_Object_SPATIAL_FILTER *
insert_spatial_filter (const Dwg_Data *dwg, const Dwg_Object *object)
{
  if (!object || !object->tio.entity
      || (object->fixedtype != DWG_TYPE_INSERT
          && object->fixedtype != DWG_TYPE_MINSERT)
      || !object->tio.entity->xdicobjhandle)
    return NULL;
  return find_spatial_filter (
      dwg,
      reference_object (dwg, object->tio.entity->xdicobjhandle), 0);
}

static int
validate_insert_clip (CacheWriter *writer,
                      const Dwg_Object_SPATIAL_FILTER *filter)
{
  uint32_t index;
  if (!filter)
    return 1;
  if (filter->num_clip_verts < 2
      || filter->num_clip_verts > MAX_INSERT_CLIP_VERTICES_PER_BOUNDARY
      || !filter->clip_verts || !filter->inverse_transform)
    {
      set_error (writer, "INSERT XCLIP boundary is unsupported or incomplete");
      return 0;
    }
  for (index = 0; index < (uint32_t)filter->num_clip_verts; index++)
    if (!isfinite (filter->clip_verts[index].x)
        || !isfinite (filter->clip_verts[index].y))
      {
        set_error (writer, "INSERT XCLIP contains a non-finite vertex");
        return 0;
      }
  for (index = 0; index < 12; index++)
    if (!isfinite (filter->inverse_transform[index]))
      {
        set_error (writer, "INSERT XCLIP contains a non-finite transform");
        return 0;
      }
  return 1;
}

/*
 * AutoCAD stores a rectangular SPATIAL_FILTER as two opposing corners in
 * the filter definition's source coordinates.  Its inverse transform maps
 * those points into the referenced block's local coordinates.  Transforming
 * only the opposing corners, then treating the result as another axis-aligned
 * rectangle, is incorrect when the INSERT is rotated or mirrored: the two
 * transformed points can even share one coordinate and collapse the clip into
 * a diagonal sliver.  Expand the source rectangle before applying the inverse
 * transform and persist it as an ordinary four-point polygon.
 */
static uint32_t
serialized_insert_clip_vertex_count (
    const Dwg_Object_SPATIAL_FILTER *filter)
{
  return filter && filter->num_clip_verts == 2
             ? 4u
             : filter ? (uint32_t)filter->num_clip_verts : 0u;
}

static void
insert_clip_source_vertex (const Dwg_Object_SPATIAL_FILTER *filter,
                           uint32_t vertex_index, double *x, double *y)
{
  if (filter->num_clip_verts == 2)
    {
      const double minimum_x = fmin (filter->clip_verts[0].x,
                                     filter->clip_verts[1].x);
      const double maximum_x = fmax (filter->clip_verts[0].x,
                                     filter->clip_verts[1].x);
      const double minimum_y = fmin (filter->clip_verts[0].y,
                                     filter->clip_verts[1].y);
      const double maximum_y = fmax (filter->clip_verts[0].y,
                                     filter->clip_verts[1].y);
      static const uint8_t x_maximum[] = { 0u, 1u, 1u, 0u };
      static const uint8_t y_maximum[] = { 0u, 0u, 1u, 1u };
      *x = x_maximum[vertex_index] ? maximum_x : minimum_x;
      *y = y_maximum[vertex_index] ? maximum_y : minimum_y;
      return;
    }
  *x = filter->clip_verts[vertex_index].x;
  *y = filter->clip_verts[vertex_index].y;
}

static int
write_insert_clip_section (CacheWriter *writer, const Dwg_Data *dwg,
                           SectionEntry *entry)
{
  uint64_t offset;
  uint64_t first_vertex = 0;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_SPATIAL_FILTER *filter
          = insert_spatial_filter (dwg, object);
      uint32_t vertex_count;
      uint32_t flags;
      if (!filter)
        continue;
      if (!validate_insert_clip (writer, filter))
        return 0;
      vertex_count = serialized_insert_clip_vertex_count (filter);
      if (count >= MAX_INSERT_CLIP_RECORDS
          || first_vertex > MAX_INSERT_CLIP_VERTICES - vertex_count)
        {
          set_error (writer, "INSERT XCLIP source exceeds its bounded limit");
          return 0;
        }
      flags = 0u;
      if (!write_u64 (writer, (uint64_t)object->handle.value)
          || !write_u64 (writer, first_vertex)
          || !write_u32 (writer, vertex_count)
          || !write_u32 (writer, flags) || !write_u64 (writer, 0))
        return 0;
      first_vertex += vertex_count;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_INSERT_CLIPS, INSERT_CLIP_RECORD_SIZE,
      "insert_clips", offset, count);
}

static int
write_insert_clip_vertex_section (CacheWriter *writer,
                                  const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_SPATIAL_FILTER *filter
          = insert_spatial_filter (dwg, object);
      uint32_t vertex_count;
      uint32_t vertex_index;
      if (!filter)
        continue;
      if (!validate_insert_clip (writer, filter))
        return 0;
      vertex_count = serialized_insert_clip_vertex_count (filter);
      if (count > MAX_INSERT_CLIP_VERTICES - vertex_count)
        {
          set_error (writer, "INSERT XCLIP vertex pool exceeds its limit");
          return 0;
        }
      for (vertex_index = 0;
           vertex_index < vertex_count;
           vertex_index++)
        {
          double source_x;
          double source_y;
          const double *inverse = filter->inverse_transform;
          double local_x;
          double local_y;
          insert_clip_source_vertex (
              filter, vertex_index, &source_x, &source_y);
          local_x = inverse[0] * source_x
                    + inverse[1] * source_y + inverse[3];
          local_y = inverse[4] * source_x
                    + inverse[5] * source_y + inverse[7];
          if (!isfinite (local_x) || !isfinite (local_y))
            {
              set_error (
                  writer,
                  "INSERT XCLIP transform produced a non-finite vertex");
              return 0;
            }
          if (!write_f64 (writer, local_x)
              || !write_f64 (writer, local_y))
            return 0;
        }
      count += vertex_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_INSERT_CLIP_VERTICES,
      INSERT_CLIP_VERTEX_RECORD_SIZE, "insert_clip_vertices", offset,
      count);
}

static int
write_polyline_header_section (CacheWriter *writer, const Dwg_Data *dwg,
                               const CacheTables *tables,
                               SectionEntry *entry)
{
  uint64_t offset;
  uint64_t first_vertex = 0;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      PolylineInfo info;
      uint64_t vertex_count;
      if (!read_polyline_info (object, &info))
        continue;
      vertex_count = polyline_vertex_count (object);
      if (vertex_count > UINT32_MAX
          || UINT64_MAX - first_vertex < vertex_count)
        {
          set_error (writer, "polyline vertex range exceeds scene cache");
          return 0;
        }
      if (!write_common (writer, object, tables)
          || !write_u64 (writer, first_vertex)
          || !write_u32 (writer, (uint32_t)vertex_count)
          || !write_u16 (writer, info.kind)
          || !write_u16 (writer, info.flags)
          || !write_f64 (writer, info.elevation)
          || !write_f64 (writer, info.thickness)
          || !write_vec3 (writer, info.normal)
          || !write_f64 (writer, info.default_start_width)
          || !write_f64 (writer, info.default_end_width)
          || !write_f64 (writer, info.constant_width))
        return 0;
      first_vertex += vertex_count;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_POLYLINE_HEADERS,
      POLYLINE_HEADER_RECORD_SIZE, "polyline_headers", offset, count);
}

static int
write_polyline_vertex_record (void *context,
                              const PolylineVertex *vertex)
{
  CacheWriter *writer = (CacheWriter *)context;
  return write_vec3 (writer, vertex->position)
         && write_f64 (writer, vertex->bulge)
         && write_f64 (writer, vertex->start_width)
         && write_f64 (writer, vertex->end_width)
         && write_f64 (writer, vertex->curve_tangent)
         && write_u32 (writer, vertex->flags)
         && write_i32 (writer, vertex->id);
}

static int
write_polyline_vertex_section (CacheWriter *writer, const Dwg_Data *dwg,
                               SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      PolylineInfo info;
      uint64_t object_count = 0;
      if (!read_polyline_info (object, &info))
        continue;
      if (!iterate_polyline_vertices (
              object, write_polyline_vertex_record, writer,
              &object_count))
        return 0;
      if (UINT64_MAX - count < object_count)
        {
          set_error (writer, "polyline vertex count overflow");
          return 0;
        }
      count += object_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_POLYLINE_VERTICES,
      POLYLINE_VERTEX_RECORD_SIZE, "polyline_vertices", offset, count);
}

static int
write_ellipse_section (CacheWriter *writer, const Dwg_Data *dwg,
                       const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      Dwg_Entity_ELLIPSE *ellipse;
      double center[3];
      double major_axis[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_ELLIPSE || !object->tio.entity
          || !(ellipse = object->tio.entity->tio.ELLIPSE))
        continue;
      center[0] = ellipse->center.x;
      center[1] = ellipse->center.y;
      center[2] = ellipse->center.z;
      major_axis[0] = ellipse->sm_axis.x;
      major_axis[1] = ellipse->sm_axis.y;
      major_axis[2] = ellipse->sm_axis.z;
      normal[0] = ellipse->extrusion.x;
      normal[1] = ellipse->extrusion.y;
      normal[2] = ellipse->extrusion.z;
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, center)
          || !write_vec3 (writer, major_axis)
          || !write_vec3 (writer, normal)
          || !write_f64 (writer, ellipse->axis_ratio)
          || !write_f64 (writer, ellipse->start_angle)
          || !write_f64 (writer, ellipse->end_angle))
        return 0;
      count++;
    }
  return finish_fixed_section (writer, entry, SECTION_ELLIPSES,
                               ELLIPSE_RECORD_SIZE, "ellipses", offset,
                               count);
}

static int
write_spline_header_section (CacheWriter *writer, const Dwg_Data *dwg,
                             const CacheTables *tables,
                             SectionEntry *entry)
{
  uint64_t offset;
  uint64_t knot_index = 0;
  uint64_t weight_index = 0;
  uint64_t control_index = 0;
  uint64_t fit_index = 0;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      uint64_t knot_count;
      uint64_t weight_count;
      uint64_t control_count;
      uint64_t fit_count;
      uint32_t flags = 0;
      double normal[3] = { 0.0, 0.0, 1.0 };
      double knot_tolerance;
      double control_tolerance;
      double begin_tangent[3];
      double end_tangent[3];
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      knot_count = (uint64_t)spline_knot_count (spline);
      weight_count = (uint64_t)spline_weight_count (spline);
      control_count = (uint64_t)spline_control_point_count (spline);
      fit_count = (uint64_t)spline_fit_point_count (spline);
      if (UINT64_MAX - knot_index < knot_count
          || UINT64_MAX - weight_index < weight_count
          || UINT64_MAX - control_index < control_count
          || UINT64_MAX - fit_index < fit_count)
        {
          set_error (writer, "spline pool index overflow");
          return 0;
        }
      if (spline_is_closed (spline))
        flags |= 1u;
      if (spline->periodic)
        flags |= 1u << 1;
      if (spline->rational)
        flags |= 1u << 2;
      knot_tolerance
          = spline->scenario == SPLINE_SCENARIO_SPLINE
                ? spline->knot_tol
                : 0.0;
      control_tolerance
          = spline->scenario == SPLINE_SCENARIO_SPLINE
                ? spline->ctrl_tol
                : 0.0;
      begin_tangent[0] = spline->beg_tan_vec.x;
      begin_tangent[1] = spline->beg_tan_vec.y;
      begin_tangent[2] = spline->beg_tan_vec.z;
      end_tangent[0] = spline->end_tan_vec.x;
      end_tangent[1] = spline->end_tan_vec.y;
      end_tangent[2] = spline->end_tan_vec.z;
      if (!write_common (writer, object, tables)
          || !write_i32 (writer, (int32_t)spline->degree)
          || !write_u32 (writer, flags)
          || !write_i32 (writer, (int32_t)spline->knotparam)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, knot_index)
          || !write_u64 (writer, knot_count)
          || !write_u64 (writer, control_index)
          || !write_u64 (writer, control_count)
          || !write_u64 (writer, weight_index)
          || !write_u64 (writer, weight_count)
          || !write_u64 (writer, fit_index)
          || !write_u64 (writer, fit_count)
          || !write_vec3 (writer, normal)
          || !write_f64 (writer, knot_tolerance)
          || !write_f64 (writer, control_tolerance)
          || !write_f64 (writer, spline->fit_tol)
          || !write_vec3 (writer, begin_tangent)
          || !write_vec3 (writer, end_tangent))
        return 0;
      knot_index += knot_count;
      weight_index += weight_count;
      control_index += control_count;
      fit_index += fit_count;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_HEADERS, SPLINE_HEADER_RECORD_SIZE,
      "spline_headers", offset, count);
}

static int
write_spline_knot_section (CacheWriter *writer, const Dwg_Data *dwg,
                           SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t knot_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      knot_count = spline_knot_count (spline);
      if (UINT64_MAX - count < (uint64_t)knot_count)
        {
          set_error (writer, "spline knot count overflow");
          return 0;
        }
      for (index = 0; index < knot_count; index++)
        {
          if (!write_f64 (writer, spline->knots[index]))
            return 0;
        }
      count += (uint64_t)knot_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_KNOTS, SPLINE_SCALAR_RECORD_SIZE,
      "spline_knots", offset, count);
}

static int
write_spline_weight_section (CacheWriter *writer, const Dwg_Data *dwg,
                             SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t weight_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      weight_count = spline_weight_count (spline);
      if (UINT64_MAX - count < (uint64_t)weight_count)
        {
          set_error (writer, "spline weight count overflow");
          return 0;
        }
      for (index = 0; index < weight_count; index++)
        {
          if (!write_f64 (writer, spline->ctrl_pts[index].w))
            return 0;
        }
      count += (uint64_t)weight_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_WEIGHTS, SPLINE_SCALAR_RECORD_SIZE,
      "spline_weights", offset, count);
}

static int
write_spline_control_point_section (CacheWriter *writer,
                                    const Dwg_Data *dwg,
                                    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t control_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      control_count = spline_control_point_count (spline);
      if (UINT64_MAX - count < (uint64_t)control_count)
        {
          set_error (writer, "spline control-point count overflow");
          return 0;
        }
      for (index = 0; index < control_count; index++)
        {
          double point[3] = { spline->ctrl_pts[index].x,
                              spline->ctrl_pts[index].y,
                              spline->ctrl_pts[index].z };
          if (!write_vec3 (writer, point))
            return 0;
        }
      count += (uint64_t)control_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_CONTROL_POINTS,
      SPLINE_POINT_RECORD_SIZE, "spline_control_points", offset, count);
}

static int
write_spline_fit_point_section (CacheWriter *writer,
                                const Dwg_Data *dwg,
                                SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t i;
  if (!align_writer (writer, &offset))
    return 0;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      const Dwg_Entity_SPLINE *spline;
      size_t fit_count;
      size_t index;
      if (object->fixedtype != DWG_TYPE_SPLINE || !object->tio.entity
          || !(spline = object->tio.entity->tio.SPLINE))
        continue;
      fit_count = spline_fit_point_count (spline);
      if (UINT64_MAX - count < (uint64_t)fit_count)
        {
          set_error (writer, "spline fit-point count overflow");
          return 0;
        }
      for (index = 0; index < fit_count; index++)
        {
          double point[3] = { spline->fit_pts[index].x,
                              spline->fit_pts[index].y,
                              spline->fit_pts[index].z };
          if (!write_vec3 (writer, point))
            return 0;
        }
      count += (uint64_t)fit_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SPLINE_FIT_POINTS,
      SPLINE_POINT_RECORD_SIZE, "spline_fit_points", offset, count);
}

static int
is_curve_linetype_source (const Dwg_Object *object)
{
  PolylineInfo info;
  return object && object->tio.entity
         && (object->fixedtype == DWG_TYPE_ARC
             || object->fixedtype == DWG_TYPE_CIRCLE
             || object->fixedtype == DWG_TYPE_ELLIPSE
             || object->fixedtype == DWG_TYPE_SPLINE
             || object->fixedtype == DWG_TYPE_XLINE
             || object->fixedtype == DWG_TYPE_RAY
             || read_polyline_info (object, &info));
}

static int
write_curve_linetype_scale_section (CacheWriter *writer,
                                    const Dwg_Data *dwg,
                                    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t index;
  if (!align_writer (writer, &offset))
    return 0;
  for (index = 0; index < (size_t)dwg->num_objects; index++)
    {
      const Dwg_Object *object = &dwg->object[index];
      const Dwg_Object_Entity *entity;
      double scale;
      if (!is_curve_linetype_source (object))
        continue;
      entity = object->tio.entity;
      scale = isfinite (entity->ltype_scale)
                      && fabs (entity->ltype_scale) > 1.0e-12
                  ? fabs (entity->ltype_scale)
                  : 1.0;
      if (!write_u64 (writer, (uint64_t)object->handle.value)
          || !write_f64 (writer, scale))
        return 0;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_CURVE_LINETYPE_SCALES,
      CURVE_LINETYPE_SCALE_RECORD_SIZE, "curve_linetype_scales", offset,
      count);
}

static uint32_t
entity_group (const Dwg_Object_Entity *entity, const CacheTables *tables)
{
  uint64_t owner = entity_owner_handle (entity, tables);
  uint32_t index
      = find_handle_index (tables->block_indices, tables->block_count, owner);
  if (index != UINT32_MAX && tables->blocks
      && index < tables->block_count)
    {
      if (tables->blocks[index].is_model)
        return UINT32_MAX;
      return index;
    }
  if (entity && entity->entmode == 2)
    return UINT32_MAX;
  return UINT32_MAX - 1u;
}

static int
initialize_entity_segment (const Dwg_Object *object,
                           const CacheTables *tables, uint8_t source_kind,
                           int approximated_curve, LineSegment *segment)
{
  Dwg_Object_Entity *entity;
  int line_weight;
  if (!object || !object->tio.entity || !segment)
    return 0;
  entity = object->tio.entity;
  memset (segment, 0, sizeof (*segment));
  segment->group = entity_group (entity, tables);
  if (segment->group == UINT32_MAX - 1u)
    return 0;
  line_weight = dxf_cvt_lweight (entity->linewt);
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  segment->handle = (uint64_t)object->handle.value;
  segment->layer_index = entity_layer_index (entity, tables);
  segment->color = encode_entity_color (&entity->color);
  segment->line_weight = (int16_t)line_weight;
  segment->flags = entity->invisible ? 1u : 0u;
  segment->source_kind = source_kind;
  segment->approximated_curve = approximated_curve ? 1u : 0u;
  segment->linetype_code = entity_linetype_code (entity, tables);
  segment->linetype_scale
      = isfinite (entity->ltype_scale)
                && fabs (entity->ltype_scale) > 1.0e-12
            ? fabs (entity->ltype_scale)
            : 1.0;
  return 1;
}

static int
iterate_proxy_graphic_segments (const Dwg_Object *object,
                                const CacheTables *tables,
                                SegmentIteration *iteration)
{
  ProxyGraphicReader reader;
  ProxyGraphicState state;
  ProxyGraphicChunk chunk;
  LineSegment base;
  uint64_t generated = 0;
  int status;
  if (!proxy_graphic_has_supported_display (object)
      || !initialize_proxy_graphic_reader (object, &reader)
      || !initialize_entity_segment (object, tables, 0u, 0, &base))
    return 1;
  initialize_proxy_graphic_state (object, tables, &state);
  while ((status = next_proxy_graphic_chunk (&reader, &chunk)) > 0)
    {
      uint32_t vertex_count;
      uint32_t edge_count;
      uint32_t edge_index;
      int control = apply_proxy_graphic_control (&state, &chunk);
      if (control < 0)
        return 1;
      if (control > 0
          || !proxy_polyline_vertex_count (&chunk, &vertex_count)
          || vertex_count < 2u)
        continue;
      edge_count = vertex_count - 1u;
      if (chunk.type == PROXY_GRAPHIC_POLYGON)
        edge_count++;
      for (edge_index = 0; edge_index < edge_count; edge_index++)
        {
          uint32_t start_index = edge_index;
          uint32_t end_index = edge_index + 1u;
          double local_start[3];
          double local_end[3];
          LineSegment segment = base;
          if (generated >= MAX_PROXY_GRAPHIC_SEGMENTS_PER_ENTITY)
            return 1;
          if (end_index == vertex_count)
            end_index = 0u;
          if (!proxy_read_vec3 (
                  chunk.data, chunk.size,
                  4u + (size_t)start_index * 3u * sizeof (double),
                  local_start)
              || !proxy_read_vec3 (
                  chunk.data, chunk.size,
                  4u + (size_t)end_index * 3u * sizeof (double),
                  local_end))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          proxy_transform_point (&state, local_start, segment.start);
          proxy_transform_point (&state, local_end, segment.end);
          segment.color = state.color;
          segment.line_weight = state.line_weight;
          segment.linetype_code
              = state.linetype_code <= GPU_STYLE_LINETYPE_MASK
                    ? (uint16_t)state.linetype_code
                    : base.linetype_code;
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
          generated++;
        }
    }
  return status >= 0;
}

static int
line_segment_from_object (const Dwg_Object *object,
                          const CacheTables *tables, LineSegment *segment)
{
  Dwg_Entity_LINE *line;
  size_t axis;
  if (object->fixedtype != DWG_TYPE_LINE || !object->tio.entity
      || !(line = object->tio.entity->tio.LINE))
    return 0;
  if (!initialize_entity_segment (object, tables, 0, 0, segment))
    return 0;
  segment->start[0] = line->start.x;
  segment->start[1] = line->start.y;
  segment->start[2] = line->start.z;
  segment->end[0] = line->end.x;
  segment->end[1] = line->end.y;
  segment->end[2] = line->end.z;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (segment->start[axis])
          || !isfinite (segment->end[axis]))
        return -1;
    }
  return 1;
}

static int
finite_point3 (const BITCODE_3BD point)
{
  return isfinite (point.x) && isfinite (point.y)
         && isfinite (point.z);
}

static int
construction_line_segment_from_object (const Dwg_Data *dwg,
                                       const Dwg_Object *object,
                                       const CacheTables *tables,
                                       LineSegment *segment)
{
  const Dwg_Entity_RAY *line;
  int is_ray;
  double bounds_min[2];
  double bounds_max[2];
  double direction[3];
  double t_min = -DBL_MAX;
  double t_max = DBL_MAX;
  double length;
  size_t axis;
  if (!dwg || !object || !object->tio.entity)
    return 0;
  if (object->fixedtype == DWG_TYPE_XLINE)
    {
      line = object->tio.entity->tio.XLINE;
      is_ray = 0;
    }
  else if (object->fixedtype == DWG_TYPE_RAY)
    {
      line = object->tio.entity->tio.RAY;
      is_ray = 1;
    }
  else
    return 0;
  if (!line || !finite_point3 (line->point)
      || !finite_point3 (line->vector))
    return -1;
  length = hypot (line->vector.x, line->vector.y);
  if (!isfinite (length) || length <= 1.0e-12)
    return -1;
  direction[0] = line->vector.x / length;
  direction[1] = line->vector.y / length;
  direction[2] = line->vector.z / length;
  bounds_min[0] = dwg->header_vars.EXTMIN.x;
  bounds_min[1] = dwg->header_vars.EXTMIN.y;
  bounds_max[0] = dwg->header_vars.EXTMAX.x;
  bounds_max[1] = dwg->header_vars.EXTMAX.y;
  if (!isfinite (bounds_min[0]) || !isfinite (bounds_min[1])
      || !isfinite (bounds_max[0]) || !isfinite (bounds_max[1])
      || bounds_min[0] > bounds_max[0]
      || bounds_min[1] > bounds_max[1]
      || bounds_max[0] - bounds_min[0] <= 1.0e-9
      || bounds_max[1] - bounds_min[1] <= 1.0e-9)
    {
      bounds_min[0] = line->point.x - 1000.0;
      bounds_min[1] = line->point.y - 1000.0;
      bounds_max[0] = line->point.x + 1000.0;
      bounds_max[1] = line->point.y + 1000.0;
    }
  else
    {
      double padding = fmax (bounds_max[0] - bounds_min[0],
                             bounds_max[1] - bounds_min[1])
                       * 0.01;
      bounds_min[0] = fmin (bounds_min[0], line->point.x) - padding;
      bounds_min[1] = fmin (bounds_min[1], line->point.y) - padding;
      bounds_max[0] = fmax (bounds_max[0], line->point.x) + padding;
      bounds_max[1] = fmax (bounds_max[1], line->point.y) + padding;
    }
  for (axis = 0; axis < 2; axis++)
    {
      double coordinate
          = axis == 0 ? line->point.x : line->point.y;
      if (fabs (direction[axis]) <= 1.0e-12)
        {
          if (coordinate < bounds_min[axis]
              || coordinate > bounds_max[axis])
            return -1;
        }
      else
        {
          double first
              = (bounds_min[axis] - coordinate) / direction[axis];
          double last
              = (bounds_max[axis] - coordinate) / direction[axis];
          double near_parameter = fmin (first, last);
          double far_parameter = fmax (first, last);
          if (near_parameter > t_min)
            t_min = near_parameter;
          if (far_parameter < t_max)
            t_max = far_parameter;
          if (t_min > t_max)
            return -1;
        }
    }
  if (is_ray && t_min < 0.0)
    t_min = 0.0;
  if (!isfinite (t_min) || !isfinite (t_max)
      || t_min > t_max
      || !initialize_entity_segment (object, tables, 9u, 1, segment))
    return -1;
  segment->start[0] = line->point.x + direction[0] * t_min;
  segment->start[1] = line->point.y + direction[1] * t_min;
  segment->start[2] = line->point.z + direction[2] * t_min;
  segment->end[0] = line->point.x + direction[0] * t_max;
  segment->end[1] = line->point.y + direction[1] * t_max;
  segment->end[2] = line->point.z + direction[2] * t_max;
  return 1;
}

static int
line_points_differ (const double start[3], const double end[3])
{
  return fabs (start[0] - end[0]) > 1.0e-9
         || fabs (start[1] - end[1]) > 1.0e-9
         || fabs (start[2] - end[2]) > 1.0e-9;
}

static void
apply_mleader_line_style (const Dwg_Entity_MULTILEADER *mleader,
                          const Dwg_LEADER_Line *line,
                          const CacheTables *tables,
                          LineSegment *segment)
{
  uint32_t linetype_code;
  int line_weight;
  if ((mleader->flags & 2u) != 0u)
    segment->color = encode_color (&mleader->line_color);
  if ((mleader->flags & 4u) != 0u)
    {
      linetype_code = find_handle_index (
          tables->linetype_codes, tables->linetype_code_count,
          reference_handle (mleader->line_ltype));
      if (linetype_code != UINT32_MAX)
        segment->linetype_code = (uint16_t)linetype_code;
    }
  if ((mleader->flags & 8u) != 0u)
    {
      line_weight = dxf_cvt_lweight (mleader->line_linewt);
      if (line_weight >= INT16_MIN && line_weight <= INT16_MAX)
        segment->line_weight = (int16_t)line_weight;
    }
  if (!line)
    return;
  if ((line->flags & 2u) != 0u)
    segment->color = encode_color (&line->color);
  if ((line->flags & 4u) != 0u)
    {
      linetype_code = find_handle_index (
          tables->linetype_codes, tables->linetype_code_count,
          reference_handle (line->ltype));
      if (linetype_code != UINT32_MAX)
        segment->linetype_code = (uint16_t)linetype_code;
    }
  if ((line->flags & 8u) != 0u)
    {
      line_weight = dxf_cvt_lweight (line->linewt);
      if (line_weight >= INT16_MIN && line_weight <= INT16_MAX)
        segment->line_weight = (int16_t)line_weight;
    }
}

static int
emit_mleader_segment (SegmentIteration *iteration,
                      const LineSegment *base,
                      const double start[3], const double end[3],
                      int approximated, uint64_t *generated)
{
  LineSegment segment;
  if (!line_points_differ (start, end))
    return 1;
  if (*generated >= MAX_MULTILEADER_SEGMENTS_PER_ENTITY)
    return 1;
  segment = *base;
  memcpy (segment.start, start, sizeof (segment.start));
  memcpy (segment.end, end, sizeof (segment.end));
  segment.approximated_curve = approximated ? 1u : 0u;
  (*generated)++;
  return segment_iteration_emit (iteration, &segment);
}

static int
emit_mleader_arrow (SegmentIteration *iteration,
                    const LineSegment *base, const double tip[3],
                    const double next[3], double arrow_size,
                    uint64_t *generated)
{
  double direction[2];
  double direction_length;
  double center[3];
  double left[3];
  double right[3];
  if (!isfinite (arrow_size) || arrow_size <= 1.0e-9)
    return 1;
  direction[0] = next[0] - tip[0];
  direction[1] = next[1] - tip[1];
  direction_length = hypot (direction[0], direction[1]);
  if (!isfinite (direction_length) || direction_length <= 1.0e-12)
    return 1;
  direction[0] /= direction_length;
  direction[1] /= direction_length;
  center[0] = tip[0] + direction[0] * arrow_size;
  center[1] = tip[1] + direction[1] * arrow_size;
  center[2] = tip[2];
  left[0] = center[0] - direction[1] * arrow_size * 0.35;
  left[1] = center[1] + direction[0] * arrow_size * 0.35;
  left[2] = tip[2];
  right[0] = center[0] + direction[1] * arrow_size * 0.35;
  right[1] = center[1] - direction[0] * arrow_size * 0.35;
  right[2] = tip[2];
  return emit_mleader_segment (
             iteration, base, tip, left, 0, generated)
         && emit_mleader_segment (
             iteration, base, left, right, 0, generated)
         && emit_mleader_segment (
             iteration, base, right, tip, 0, generated);
}

static int
iterate_mleader_segments (const Dwg_Object *object,
                          const CacheTables *tables,
                          SegmentIteration *iteration)
{
  const Dwg_Entity_MULTILEADER *mleader;
  size_t leader_count;
  size_t leader_index;
  uint64_t generated = 0;
  if (!object || object->fixedtype != DWG_TYPE_MULTILEADER
      || !object->tio.entity
      || !(mleader = object->tio.entity->tio.MULTILEADER))
    return 1;
  if (!mleader->ctx.leaders || mleader->ctx.num_leaders <= 0)
    return 1;
  leader_count = (size_t)mleader->ctx.num_leaders;
  if (leader_count > MAX_MULTILEADER_NODES)
    leader_count = MAX_MULTILEADER_NODES;
  for (leader_index = 0; leader_index < leader_count; leader_index++)
    {
      const Dwg_LEADER_Node *node
          = &mleader->ctx.leaders[leader_index];
      size_t line_count;
      size_t line_index;
      if (!node->lines || node->num_lines <= 0)
        continue;
      line_count = (size_t)node->num_lines;
      if (line_count > MAX_MULTILEADER_LINES_PER_NODE)
        line_count = MAX_MULTILEADER_LINES_PER_NODE;
      for (line_index = 0; line_index < line_count; line_index++)
        {
          const Dwg_LEADER_Line *line = &node->lines[line_index];
          LineSegment base;
          size_t point_count;
          size_t point_index;
          double last[3];
          int has_last = 0;
          if (line->type == 0 || !line->points
              || line->num_points <= 0)
            continue;
          if (!initialize_entity_segment (
                  object, tables, 10u, line->type == 2, &base))
            continue;
          apply_mleader_line_style (mleader, line, tables, &base);
          point_count = (size_t)line->num_points;
          if (point_count > MAX_MULTILEADER_POINTS_PER_LINE)
            point_count = MAX_MULTILEADER_POINTS_PER_LINE;
          for (point_index = 0; point_index < point_count; point_index++)
            {
              double current[3] = {
                line->points[point_index].x,
                line->points[point_index].y,
                line->points[point_index].z
              };
              if (!isfinite (current[0]) || !isfinite (current[1])
                  || !isfinite (current[2]))
                {
                  segment_iteration_reject (iteration);
                  has_last = 0;
                  continue;
                }
              if (has_last
                  && line->type == 2)
                {
                  double p0[3];
                  double p3[3];
                  double previous[3];
                  uint32_t subdivision;
                  const BITCODE_3BD *before
                      = point_index >= 2u
                            ? &line->points[point_index - 2u]
                            : &line->points[point_index - 1u];
                  const BITCODE_3BD *after
                      = point_index + 1u < point_count
                            ? &line->points[point_index + 1u]
                            : &line->points[point_index];
                  p0[0] = finite_point3 (*before) ? before->x : last[0];
                  p0[1] = finite_point3 (*before) ? before->y : last[1];
                  p0[2] = finite_point3 (*before) ? before->z : last[2];
                  p3[0] = finite_point3 (*after) ? after->x : current[0];
                  p3[1] = finite_point3 (*after) ? after->y : current[1];
                  p3[2] = finite_point3 (*after) ? after->z : current[2];
                  memcpy (previous, last, sizeof (previous));
                  for (subdivision = 1u;
                       subdivision <= MULTILEADER_SPLINE_SEGMENTS_PER_SPAN;
                       subdivision++)
                    {
                      double t
                          = (double)subdivision
                            / MULTILEADER_SPLINE_SEGMENTS_PER_SPAN;
                      double t2 = t * t;
                      double t3 = t2 * t;
                      double sample[3];
                      size_t axis;
                      for (axis = 0; axis < 3u; axis++)
                        sample[axis]
                            = 0.5
                              * (2.0 * last[axis]
                                 + (-p0[axis] + current[axis]) * t
                                 + (2.0 * p0[axis]
                                    - 5.0 * last[axis]
                                    + 4.0 * current[axis]
                                    - p3[axis])
                                       * t2
                                 + (-p0[axis] + 3.0 * last[axis]
                                    - 3.0 * current[axis]
                                    + p3[axis])
                                       * t3);
                      if (!emit_mleader_segment (
                              iteration, &base, previous, sample, 1,
                              &generated))
                        return 0;
                      memcpy (previous, sample, sizeof (previous));
                    }
                }
              else if (has_last
                       && !emit_mleader_segment (
                           iteration, &base, last, current, 0,
                           &generated))
                return 0;
              memcpy (last, current, sizeof (last));
              has_last = 1;
            }
          if (has_last && node->has_lastleaderlinepoint
              && finite_point3 (node->lastleaderlinepoint))
            {
              double landing[3] = {
                node->lastleaderlinepoint.x,
                node->lastleaderlinepoint.y,
                node->lastleaderlinepoint.z
              };
              double arrow_size
                  = isfinite (line->arrow_size)
                            && line->arrow_size > 1.0e-9
                        ? line->arrow_size
                        : isfinite (mleader->arrow_size)
                                  && mleader->arrow_size > 1.0e-9
                              ? mleader->arrow_size
                              : mleader->ctx.arrow_size;
              double tip[3] = {
                line->points[0].x,
                line->points[0].y,
                line->points[0].z
              };
              double next[3];
              if (point_count > 1)
                {
                  next[0] = line->points[1].x;
                  next[1] = line->points[1].y;
                  next[2] = line->points[1].z;
                }
              else
                memcpy (next, landing, sizeof (next));
              if (!emit_mleader_segment (
                      iteration, &base, last, landing,
                      line->type == 2, &generated)
                  || !emit_mleader_arrow (
                      iteration, &base, tip, next, arrow_size,
                      &generated))
                return 0;
              memcpy (last, landing, sizeof (last));
              if (node->has_dogleg
                  && finite_point3 (node->dogleg_vector)
                  && isfinite (node->dogleg_length)
                  && node->dogleg_length > 1.0e-9)
                {
                  double dogleg[3] = {
                    last[0]
                        + node->dogleg_vector.x
                              * node->dogleg_length,
                    last[1]
                        + node->dogleg_vector.y
                              * node->dogleg_length,
                    last[2]
                        + node->dogleg_vector.z
                              * node->dogleg_length
                  };
                  if (!emit_mleader_segment (
                          iteration, &base, last, dogleg, 0,
                          &generated))
                    return 0;
                }
            }
        }
    }
  return 1;
}

static int
iterate_leader_segments (const Dwg_Object *object,
                         const CacheTables *tables,
                         SegmentIteration *iteration)
{
  const Dwg_Entity_LEADER *leader;
  LineSegment base;
  size_t point_count;
  size_t point_index;
  uint64_t generated = 0;
  double first[3] = { 0.0, 0.0, 0.0 };
  double second[3] = { 0.0, 0.0, 0.0 };
  double last[3] = { 0.0, 0.0, 0.0 };
  int finite_count = 0;
  int has_last = 0;
  if (!object || object->fixedtype != DWG_TYPE_LEADER
      || !object->tio.entity
      || !(leader = object->tio.entity->tio.LEADER))
    return 1;
  if (!leader->points || leader->num_points <= 0)
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  if (!initialize_entity_segment (
          object, tables, 12u, leader->path_type != 0, &base))
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  point_count = (size_t)leader->num_points;
  if (point_count > MAX_LEADER_POINTS_PER_ENTITY)
    point_count = MAX_LEADER_POINTS_PER_ENTITY;
  for (point_index = 0; point_index < point_count; point_index++)
    {
      double current[3] = {
        leader->points[point_index].x,
        leader->points[point_index].y,
        leader->points[point_index].z
      };
      if (!isfinite (current[0]) || !isfinite (current[1])
          || !isfinite (current[2]))
        {
          segment_iteration_reject (iteration);
          has_last = 0;
          continue;
        }
      if (finite_count == 0)
        memcpy (first, current, sizeof (first));
      else if (finite_count == 1)
        memcpy (second, current, sizeof (second));
      finite_count++;
      if (has_last
          && !emit_mleader_segment (
              iteration, &base, last, current,
              leader->path_type != 0, &generated))
        return 0;
      memcpy (last, current, sizeof (last));
      has_last = 1;
    }
  if (finite_count >= 2 && leader->arrowhead_on)
    {
      double arrow_size
          = isfinite (leader->dimasz) && leader->dimasz > 1.0e-9
                ? leader->dimasz
                : 0.0;
      if (!emit_mleader_arrow (
              iteration, &base, first, second, arrow_size, &generated))
        return 0;
    }
  if (has_last && leader->hookline_on
      && finite_point3 (leader->x_direction))
    {
      double direction[3] = {
        leader->x_direction.x,
        leader->x_direction.y,
        leader->x_direction.z
      };
      double length = sqrt (direction[0] * direction[0]
                            + direction[1] * direction[1]
                            + direction[2] * direction[2]);
      double hook_length
          = (isfinite (leader->box_width)
                     ? fabs (leader->box_width)
                     : 0.0)
            + (isfinite (leader->dimgap)
                       ? fabs (leader->dimgap)
                       : 0.0);
      if (isfinite (length) && length > 1.0e-12
          && hook_length > 1.0e-9)
        {
          double sign = leader->hookline_dir ? 1.0 : -1.0;
          double hook[3] = {
            last[0] + sign * direction[0] / length * hook_length,
            last[1] + sign * direction[1] / length * hook_length,
            last[2] + sign * direction[2] / length * hook_length
          };
          if (!emit_mleader_segment (
                  iteration, &base, last, hook, 0, &generated))
            return 0;
        }
    }
  return 1;
}

static int
read_embedded_ole_f64 (const uint8_t *bytes, double *value)
{
  uint64_t bits = 0;
  size_t byte_index;
  if (!bytes || !value)
    return 0;
  for (byte_index = 0; byte_index < sizeof (bits); byte_index++)
    bits |= (uint64_t)bytes[byte_index] << (byte_index * 8u);
  memcpy (value, &bits, sizeof (*value));
  return isfinite (*value);
}

enum
{
  EMBEDDED_IMAGE_MIME_BMP = 1u,
  EMBEDDED_IMAGE_MIME_EMF = 2u,
  EMBEDDED_IMAGE_FLAG_SOURCE_BMP = 1u,
  EMBEDDED_IMAGE_FLAG_SOURCE_EMF = (1u << 1)
};

typedef struct
{
  const Dwg_Object *object;
  const uint8_t *bmp;
  const uint8_t *bmi;
  const uint8_t *bits;
  uint8_t *owned_payload;
  uint32_t bmp_length;
  uint32_t bmi_length;
  uint32_t bits_length;
  uint32_t width;
  uint32_t height;
  uint32_t mime_type;
  uint32_t flags;
  uint64_t payload_offset;
  uint64_t payload_length;
} EmbeddedImagePreview;

typedef struct
{
  EmbeddedImagePreview *items;
  size_t count;
  size_t available_count;
  size_t source_image_count;
  uint64_t byte_length;
} EmbeddedImageTable;

static int
validate_embedded_emf (const uint8_t *data, size_t size,
                       uint32_t *width, uint32_t *height)
{
  uint32_t header_type;
  uint32_t header_size;
  uint32_t signature;
  uint32_t declared_size;
  uint32_t declared_records;
  int32_t left;
  int32_t top;
  int32_t right;
  int32_t bottom;
  int64_t signed_width;
  int64_t signed_height;
  uint64_t pixels;
  size_t cursor = 0;
  uint32_t record_count = 0;
  uint32_t last_type = 0;
  if (!data || !width || !height || size < 88u
      || size > MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD
      || !proxy_read_u32 (data, size, 0, &header_type)
      || !proxy_read_u32 (data, size, 4, &header_size)
      || !proxy_read_i32 (data, size, 8, &left)
      || !proxy_read_i32 (data, size, 12, &top)
      || !proxy_read_i32 (data, size, 16, &right)
      || !proxy_read_i32 (data, size, 20, &bottom)
      || !proxy_read_u32 (data, size, 40, &signature)
      || !proxy_read_u32 (data, size, 48, &declared_size)
      || !proxy_read_u32 (data, size, 52, &declared_records)
      || header_type != 1u || header_size < 88u
      || (header_size & 3u) != 0u || header_size > size
      || signature != 0x464d4520u || declared_size != size
      || declared_records < 2u
      || declared_records > MAX_EMBEDDED_EMF_RECORDS)
    return 0;
  signed_width = (int64_t)right - left;
  signed_height = (int64_t)bottom - top;
  if (signed_width <= 0 || signed_height <= 0
      || signed_width > UINT32_MAX || signed_height > UINT32_MAX)
    return 0;
  pixels = (uint64_t)signed_width * (uint64_t)signed_height;
  if (!pixels || pixels > MAX_EMBEDDED_IMAGE_PIXELS)
    return 0;
  while (cursor < size)
    {
      uint32_t record_type;
      uint32_t record_size;
      if (record_count >= MAX_EMBEDDED_EMF_RECORDS
          || size - cursor < 8u
          || !proxy_read_u32 (
              data + cursor, size - cursor, 0, &record_type)
          || !proxy_read_u32 (
              data + cursor, size - cursor, 4, &record_size)
          || record_size < 8u || (record_size & 3u) != 0u
          || record_size > size - cursor
          || (record_count == 0u && record_type != 1u))
        return 0;
      last_type = record_type;
      cursor += record_size;
      record_count++;
    }
  if (cursor != size || last_type != 14u
      || record_count != declared_records)
    return 0;
  *width = (uint32_t)signed_width;
  *height = (uint32_t)signed_height;
  return 1;
}

static int
wmfc_header (const uint8_t *data, size_t size, size_t offset,
             uint32_t *chunk_count, uint32_t *chunk_size,
             uint32_t *remaining_size, uint32_t *total_size)
{
  uint32_t identifier;
  uint32_t comment_type;
  uint32_t version;
  uint32_t flags;
  if (!data || offset > size || size - offset < WMFC_HEADER_SIZE
      || !proxy_read_u32 (data + offset, size - offset, 0, &identifier)
      || !proxy_read_u32 (
          data + offset, size - offset, 4, &comment_type)
      || !proxy_read_u32 (data + offset, size - offset, 8, &version)
      || !proxy_read_u32 (data + offset, size - offset, 14, &flags)
      || !proxy_read_u32 (
          data + offset, size - offset, 18, chunk_count)
      || !proxy_read_u32 (
          data + offset, size - offset, 22, chunk_size)
      || !proxy_read_u32 (
          data + offset, size - offset, 26, remaining_size)
      || !proxy_read_u32 (
          data + offset, size - offset, 30, total_size)
      || identifier != 0x43464d57u || comment_type != 1u
      || version != 0x00010000u || flags != 0u)
    return 0;
  return 1;
}

static int
reconstruct_wmfc_emf (const uint8_t *data, size_t size,
                      uint8_t **payload, uint32_t *payload_length,
                      uint32_t *width, uint32_t *height)
{
  size_t search_cursor = 0;
  if (!data || !payload || !payload_length || !width || !height)
    return 0;
  while (search_cursor + WMFC_HEADER_SIZE <= size)
    {
      const uint8_t *found = (const uint8_t *)memchr (
          data + search_cursor, 'W', size - search_cursor);
      size_t offset;
      uint32_t expected_chunks;
      uint32_t chunk_size;
      uint32_t remaining_size;
      uint32_t total_size;
      uint8_t *candidate;
      uint32_t copied = 0;
      uint32_t chunk_index;
      size_t chunk_offset;
      int valid = 1;
      if (!found)
        break;
      offset = (size_t)(found - data);
      search_cursor = offset + 1u;
      if (!wmfc_header (
              data, size, offset, &expected_chunks, &chunk_size,
              &remaining_size, &total_size)
          || expected_chunks == 0u
          || expected_chunks > MAX_EMBEDDED_WMFC_CHUNKS
          || total_size < 88u
          || total_size > MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD
          || chunk_size == 0u || chunk_size > total_size
          || remaining_size != total_size - chunk_size
          || offset > size - WMFC_HEADER_SIZE
          || chunk_size > size - offset - WMFC_HEADER_SIZE)
        continue;
      candidate = (uint8_t *)malloc (total_size);
      if (!candidate)
        return 0;
      chunk_offset = offset;
      for (chunk_index = 0; chunk_index < expected_chunks;
           chunk_index++)
        {
          uint32_t current_chunks;
          uint32_t current_chunk_size;
          uint32_t current_remaining_size;
          uint32_t current_total_size;
          if (!wmfc_header (
                  data, size, chunk_offset, &current_chunks,
                  &current_chunk_size, &current_remaining_size,
                  &current_total_size)
              || current_chunks != expected_chunks
              || current_total_size != total_size
              || current_chunk_size == 0u
              || current_chunk_size > total_size - copied
              || current_remaining_size
                     != total_size - copied - current_chunk_size
              || chunk_offset > size - WMFC_HEADER_SIZE
              || current_chunk_size
                     > size - chunk_offset - WMFC_HEADER_SIZE)
            {
              valid = 0;
              break;
            }
          memcpy (
              candidate + copied,
              data + chunk_offset + WMFC_HEADER_SIZE,
              current_chunk_size);
          copied += current_chunk_size;
          if (chunk_index + 1u < expected_chunks)
            {
              size_t padded_chunk_size
                  = (size_t)current_chunk_size
                    + (current_chunk_size & 1u);
              if (chunk_offset
                      > SIZE_MAX - WMFC_HEADER_SIZE
                                      - padded_chunk_size
                                      - WMFC_RECORD_PREFIX_SIZE)
                {
                  valid = 0;
                  break;
                }
              chunk_offset += WMFC_HEADER_SIZE + padded_chunk_size
                              + WMFC_RECORD_PREFIX_SIZE;
            }
        }
      if (valid && copied == total_size
          && validate_embedded_emf (
              candidate, total_size, width, height))
        {
          *payload = candidate;
          *payload_length = total_size;
          return 1;
        }
      free (candidate);
    }
  return 0;
}

static int
validate_embedded_dib (const uint8_t *data, size_t size,
                       uint32_t *width, uint32_t *height,
                       uint16_t *bits_per_pixel)
{
  uint32_t header_size;
  uint32_t compression;
  uint16_t planes;
  uint16_t depth;
  int32_t signed_width;
  int32_t signed_height;
  uint64_t pixels;
  if (!data || size < 40u
      || !proxy_read_u32 (data, size, 0, &header_size)
      || header_size < 40u || header_size > size
      || !proxy_read_i32 (data, size, 4, &signed_width)
      || !proxy_read_i32 (data, size, 8, &signed_height)
      || !proxy_read_u16 (data, size, 12, &planes)
      || !proxy_read_u16 (data, size, 14, &depth)
      || !proxy_read_u32 (data, size, 16, &compression)
      || signed_width <= 0 || signed_height == 0
      || signed_height == INT32_MIN || planes != 1u
      || (depth != 1u && depth != 4u && depth != 8u
          && depth != 16u && depth != 24u && depth != 32u)
      || (compression != 0u && compression != 3u)
      || (compression == 3u && depth != 16u && depth != 32u))
    return 0;
  pixels = (uint64_t)(uint32_t)signed_width
           * (uint64_t)(signed_height < 0 ? -signed_height
                                          : signed_height);
  if (!pixels || pixels > MAX_EMBEDDED_IMAGE_PIXELS)
    return 0;
  *width = (uint32_t)signed_width;
  *height = (uint32_t)(signed_height < 0 ? -signed_height
                                         : signed_height);
  *bits_per_pixel = depth;
  return 1;
}

static int
validate_embedded_bmp (const uint8_t *data, size_t size,
                       uint32_t *byte_length, uint32_t *width,
                       uint32_t *height, uint16_t *bits_per_pixel)
{
  uint32_t file_size;
  uint32_t pixel_offset;
  uint32_t dib_size;
  if (!data || size < 54u || data[0] != 'B' || data[1] != 'M'
      || !proxy_read_u32 (data, size, 2, &file_size)
      || !proxy_read_u32 (data, size, 10, &pixel_offset)
      || !proxy_read_u32 (data, size, 14, &dib_size)
      || file_size < 54u || file_size > size
      || file_size > MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD
      || dib_size < 40u || dib_size > file_size - 14u
      || pixel_offset < 14u + dib_size || pixel_offset >= file_size
      || !validate_embedded_dib (
          data + 14u, file_size - 14u, width, height,
          bits_per_pixel))
    return 0;
  *byte_length = file_size;
  return 1;
}

static int
embedded_image_candidate_is_better (
    uint32_t width, uint32_t height, uint16_t depth,
    uint32_t byte_length, uint32_t best_width, uint32_t best_height,
    uint16_t best_depth, uint32_t best_byte_length)
{
  uint64_t pixels = (uint64_t)width * height;
  uint64_t best_pixels = (uint64_t)best_width * best_height;
  return pixels > best_pixels
         || (pixels == best_pixels && depth > best_depth)
         || (pixels == best_pixels && depth == best_depth
             && byte_length > best_byte_length);
}

static int
select_embedded_ole_preview (const Dwg_Object *object,
                             EmbeddedImagePreview *preview)
{
  const Dwg_Entity_OLE2FRAME *frame;
  const uint8_t *data;
  size_t size;
  size_t cursor;
  const uint8_t *best_bmp = NULL;
  uint32_t best_bmp_length = 0;
  uint32_t best_width = 0;
  uint32_t best_height = 0;
  uint16_t best_depth = 0;
  if (!object || !preview || object->fixedtype != DWG_TYPE_OLE2FRAME
      || !object->tio.entity
      || !(frame = object->tio.entity->tio.OLE2FRAME)
      || !frame->data || frame->data_size < 54u)
    return 0;
  data = frame->data;
  size = (size_t)frame->data_size;
  if (size > MAX_EMBEDDED_IMAGE_SCAN_BYTES)
    size = MAX_EMBEDDED_IMAGE_SCAN_BYTES;

  cursor = 0;
  while (cursor + 54u <= size)
    {
      const uint8_t *found
          = (const uint8_t *)memchr (data + cursor, 'B', size - cursor);
      uint32_t length;
      uint32_t width;
      uint32_t height;
      uint16_t depth;
      size_t offset;
      if (!found)
        break;
      offset = (size_t)(found - data);
      if (offset + 54u <= size && found[1] == 'M'
          && validate_embedded_bmp (
              found, size - offset, &length, &width, &height, &depth)
          && embedded_image_candidate_is_better (
              width, height, depth, length, best_width, best_height,
              best_depth, best_bmp_length))
        {
          best_bmp = found;
          best_bmp_length = length;
          best_width = width;
          best_height = height;
          best_depth = depth;
        }
      cursor = offset + 1u;
    }
  if (best_bmp)
    {
      preview->bmp = best_bmp;
      preview->bmp_length = best_bmp_length;
      preview->width = best_width;
      preview->height = best_height;
      preview->mime_type = EMBEDDED_IMAGE_MIME_BMP;
      preview->flags = EMBEDDED_IMAGE_FLAG_SOURCE_BMP;
      preview->payload_length = best_bmp_length;
      return 1;
    }

  cursor = 0;
  while (cursor + 80u <= size)
    {
      const uint8_t *found
          = (const uint8_t *)memchr (data + cursor, 81, size - cursor);
      uint32_t record_size;
      uint32_t bmi_offset;
      uint32_t bmi_length;
      uint32_t bits_offset;
      uint32_t bits_length;
      uint32_t width;
      uint32_t height;
      uint16_t depth;
      uint32_t payload_length;
      size_t offset;
      if (!found)
        break;
      offset = (size_t)(found - data);
      if (offset + 80u <= size && found[1] == 0u && found[2] == 0u
          && found[3] == 0u
          && proxy_read_u32 (found, size - offset, 4, &record_size)
          && record_size >= 80u && (record_size & 3u) == 0u
          && record_size <= size - offset
          && proxy_read_u32 (found, record_size, 48, &bmi_offset)
          && proxy_read_u32 (found, record_size, 52, &bmi_length)
          && proxy_read_u32 (found, record_size, 56, &bits_offset)
          && proxy_read_u32 (found, record_size, 60, &bits_length)
          && bmi_length >= 40u && bits_length > 0u
          && bmi_offset >= 80u && bits_offset >= 80u
          && bmi_offset <= record_size
          && bmi_length <= record_size - bmi_offset
          && bits_offset <= record_size
          && bits_length <= record_size - bits_offset
          && bmi_length <= UINT32_MAX - 14u
          && bits_length <= UINT32_MAX - 14u - bmi_length
          && (payload_length = 14u + bmi_length + bits_length)
                 <= MAX_EMBEDDED_IMAGE_BYTES_PER_RECORD
          && validate_embedded_dib (
              found + bmi_offset, bmi_length, &width, &height, &depth)
          && embedded_image_candidate_is_better (
              width, height, depth, payload_length, best_width,
              best_height, best_depth,
              preview->bmi_length + preview->bits_length + 14u))
        {
          preview->bmi = found + bmi_offset;
          preview->bits = found + bits_offset;
          preview->bmi_length = bmi_length;
          preview->bits_length = bits_length;
          preview->width = width;
          preview->height = height;
          preview->mime_type = EMBEDDED_IMAGE_MIME_BMP;
          preview->flags = 0;
          preview->payload_length = payload_length;
          best_width = width;
          best_height = height;
          best_depth = depth;
        }
      cursor = offset + 1u;
    }
  if (preview->payload_length > 0u)
    return 1;
  if (reconstruct_wmfc_emf (
          data, size, &preview->owned_payload,
          &preview->bmp_length, &preview->width, &preview->height))
    {
      preview->mime_type = EMBEDDED_IMAGE_MIME_EMF;
      preview->flags = EMBEDDED_IMAGE_FLAG_SOURCE_EMF;
      preview->payload_length = preview->bmp_length;
      return 1;
    }
  return 0;
}

static int
ole2frame_corners (const Dwg_Entity_OLE2FRAME *frame,
                   double points[4][3])
{
  size_t point_index;
  size_t axis;
  double signed_area = 0.0;
  if (!frame || !points)
    return 0;
  /*
   * LibreDWG 0.14 leaves the public pt1/pt2 fields at the embedded object's
   * natural size for binary DWG OLE2FRAME records. AutoCAD's 128-byte OLE
   * preamble starts with 0x5580 or 0x5581 and stores the four actual WCS
   * corners as twelve little-endian f64 values at byte 2, before the CFB
   * stream. Both markers occur in supported production drawings.
   */
  if (frame->data && frame->data_size >= 98u
      && (frame->data[0] == 0x80u || frame->data[0] == 0x81u)
      && frame->data[1] == 0x55u)
    {
      for (point_index = 0; point_index < 4; point_index++)
        for (axis = 0; axis < 3; axis++)
          if (!read_embedded_ole_f64 (
                  frame->data + 2u
                      + (point_index * 3u + axis) * sizeof (double),
                  &points[point_index][axis]))
            return 0;
      for (point_index = 0; point_index < 4; point_index++)
        {
          size_t next = (point_index + 1u) % 4u;
          signed_area
              += points[point_index][0] * points[next][1]
                 - points[next][0] * points[point_index][1];
        }
      if (fabs (signed_area) > 1.0e-12)
        return 1;
    }
  if (!finite_point3 (frame->pt1) || !finite_point3 (frame->pt2)
      || (fabs (frame->pt1.x - frame->pt2.x) <= 1.0e-12
          && fabs (frame->pt1.y - frame->pt2.y) <= 1.0e-12))
    return 0;
  points[0][0] = frame->pt1.x;
  points[0][1] = frame->pt1.y;
  points[0][2] = frame->pt1.z;
  points[1][0] = frame->pt2.x;
  points[1][1] = frame->pt1.y;
  points[1][2] = frame->pt1.z;
  points[2][0] = frame->pt2.x;
  points[2][1] = frame->pt2.y;
  points[2][2] = frame->pt2.z;
  points[3][0] = frame->pt1.x;
  points[3][1] = frame->pt2.y;
  points[3][2] = frame->pt2.z;
  return 1;
}

static void
free_embedded_image_table (EmbeddedImageTable *table)
{
  size_t index;
  if (!table)
    return;
  for (index = 0; index < table->count; index++)
    free (table->items[index].owned_payload);
  free (table->items);
  memset (table, 0, sizeof (*table));
}

static int
collect_embedded_image_table (CacheWriter *writer, const Dwg_Data *dwg,
                              EmbeddedImageTable *table)
{
  size_t object_index;
  size_t ole_count = 0;
  if (!writer || !dwg || !table)
    return 0;
  memset (table, 0, sizeof (*table));
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      double points[4][3];
      if (object->fixedtype == DWG_TYPE_IMAGE && object->tio.entity
          && object->tio.entity->tio.IMAGE)
        table->source_image_count++;
      else if (object->fixedtype == DWG_TYPE_OLE2FRAME
               && object->tio.entity
               && object->tio.entity->tio.OLE2FRAME
               && ole2frame_corners (
                   object->tio.entity->tio.OLE2FRAME, points))
        ole_count++;
    }
  if (table->source_image_count > MAX_IMAGE_SOURCE_RECORDS
      || ole_count > MAX_IMAGE_SOURCE_RECORDS - table->source_image_count)
    {
      set_error (writer, "embedded IMAGE placements exceed cache limits");
      return 0;
    }
  if (ole_count)
    {
      if (ole_count > SIZE_MAX / sizeof (*table->items))
        {
          set_error (writer, "embedded IMAGE table exceeds host limits");
          return 0;
        }
      table->items = (EmbeddedImagePreview *)calloc (
          ole_count, sizeof (*table->items));
      if (!table->items)
        {
          set_error (writer, "cannot allocate bounded embedded IMAGE table");
          return 0;
        }
    }
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_OLE2FRAME *frame;
      EmbeddedImagePreview *preview;
      double points[4][3];
      if (object->fixedtype != DWG_TYPE_OLE2FRAME || !object->tio.entity
          || !(frame = object->tio.entity->tio.OLE2FRAME)
          || !ole2frame_corners (frame, points))
        continue;
      preview = &table->items[table->count++];
      preview->object = object;
      if (!select_embedded_ole_preview (object, preview))
        continue;
      if (preview->payload_length > MAX_EMBEDDED_IMAGE_BYTES
          || table->byte_length
                 > MAX_EMBEDDED_IMAGE_BYTES - preview->payload_length)
        {
          free (preview->owned_payload);
          preview->bmp = NULL;
          preview->bmi = NULL;
          preview->bits = NULL;
          preview->owned_payload = NULL;
          preview->bmp_length = 0;
          preview->bmi_length = 0;
          preview->bits_length = 0;
          preview->width = 0;
          preview->height = 0;
          preview->mime_type = 0;
          preview->flags = 0;
          preview->payload_length = 0;
          continue;
        }
      preview->payload_offset = table->byte_length;
      table->byte_length += preview->payload_length;
      table->available_count++;
    }
  return 1;
}

static int
iterate_ole2frame_segments (const Dwg_Object *object,
                            const CacheTables *tables,
                            SegmentIteration *iteration)
{
  const Dwg_Entity_OLE2FRAME *frame;
  LineSegment base;
  double points[4][3];
  uint64_t generated = 0;
  size_t index;
  if (!object || object->fixedtype != DWG_TYPE_OLE2FRAME
      || !object->tio.entity
      || !(frame = object->tio.entity->tio.OLE2FRAME))
    return 1;
  if (((tables->presentation_settings >> 6) & 3u) == 0u)
    return 1;
  if (!ole2frame_corners (frame, points)
      || !initialize_entity_segment (object, tables, 13u, 1, &base))
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  for (index = 0; index < 4; index++)
    {
      if (!emit_mleader_segment (
              iteration, &base, points[index],
              points[(index + 1) % 4], 1, &generated))
        return 0;
    }
  return 1;
}

static int
is_primary_paper_viewport (const Dwg_Data *dwg,
                           const Dwg_Object *object,
                           const Dwg_Entity_VIEWPORT *viewport,
                           const CacheTables *tables)
{
  uint64_t active_handle = 0;
  uint64_t best_handle = 0;
  uint64_t handle;
  uint64_t owner_handle;
  double best_error = HUGE_VAL;
  size_t object_index;
  if (!dwg || !object || !viewport || !tables || !object->tio.entity)
    return 0;
  if (viewport->id == 1)
    return 1;
  handle = (uint64_t)object->handle.value;
  owner_handle = entity_owner_handle (object->tio.entity, tables);
  for (object_index = 0;
       object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *candidate = &dwg->object[object_index];
      const Dwg_Entity_VIEWPORT *candidate_viewport;
      double center_error;
      double direction_length;
      double direction_error;
      double error;
      double height_error;
      double scale;
      double target_error;
      double twist_error;
      if (!is_viewport_entity (candidate)
          || entity_owner_handle (candidate->tio.entity, tables)
                 != owner_handle
          || !(candidate_viewport
                   = candidate->tio.entity->tio.VIEWPORT))
        continue;
      if (candidate_viewport->id == 1)
        return 0;
      if (!isfinite (candidate_viewport->center.x)
          || !isfinite (candidate_viewport->center.y)
          || !isfinite (candidate_viewport->width)
          || !isfinite (candidate_viewport->height)
          || !isfinite (candidate_viewport->VIEWCTR.x)
          || !isfinite (candidate_viewport->VIEWCTR.y)
          || !finite_point3 (candidate_viewport->view_target)
          || !finite_point3 (candidate_viewport->VIEWDIR)
          || !isfinite (candidate_viewport->VIEWTWIST)
          || !isfinite (candidate_viewport->VIEWSIZE)
          || candidate_viewport->width <= 0.0
          || candidate_viewport->height <= 0.0
          || candidate_viewport->VIEWSIZE <= 0.0)
        continue;
      scale = fmax (
          fabs (candidate_viewport->width),
          fmax (fabs (candidate_viewport->height),
                fmax (fabs (candidate_viewport->VIEWSIZE), 1.0)));
      direction_length
          = hypot (hypot (candidate_viewport->VIEWDIR.x,
                          candidate_viewport->VIEWDIR.y),
                   candidate_viewport->VIEWDIR.z);
      if (!isfinite (direction_length) || direction_length <= 1.0e-12)
        continue;
      center_error
          = hypot (candidate_viewport->VIEWCTR.x
                       - candidate_viewport->center.x,
                   candidate_viewport->VIEWCTR.y
                       - candidate_viewport->center.y)
            / scale;
      height_error
          = fabs (candidate_viewport->VIEWSIZE
                  - candidate_viewport->height)
            / fmax (fmax (candidate_viewport->VIEWSIZE,
                          candidate_viewport->height),
                    1.0);
      target_error
          = hypot (hypot (candidate_viewport->view_target.x,
                          candidate_viewport->view_target.y),
                   candidate_viewport->view_target.z)
            / scale;
      direction_error
          = hypot (
              hypot (candidate_viewport->VIEWDIR.x / direction_length,
                     candidate_viewport->VIEWDIR.y / direction_length),
              candidate_viewport->VIEWDIR.z / direction_length - 1.0);
      twist_error
          = 2.0 * fabs (sin (candidate_viewport->VIEWTWIST * 0.5));
      error = center_error + height_error + target_error
              + direction_error + twist_error;
      if (isfinite (error) && error < best_error)
        {
          best_error = error;
          best_handle = (uint64_t)candidate->handle.value;
        }
    }
  if (best_handle)
    return best_handle == handle;
  for (object_index = 0;
       object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *candidate = &dwg->object[object_index];
      const Dwg_Object_LAYOUT *layout;
      if (candidate->fixedtype != DWG_TYPE_LAYOUT
          || !candidate->tio.object
          || !(layout = candidate->tio.object->tio.LAYOUT))
        continue;
      if (reference_handle (layout->block_header) == owner_handle)
        {
          active_handle = reference_handle (layout->active_viewport);
          break;
        }
    }
  return active_handle == handle;
}

static int
iterate_viewport_frame_segments (const Dwg_Data *dwg,
                                 const Dwg_Object *object,
                                 const CacheTables *tables,
                                 SegmentIteration *iteration)
{
  const Dwg_Entity_VIEWPORT *viewport;
  LineSegment base;
  double points[4][3];
  double half_width;
  double half_height;
  size_t index;
  if (!is_viewport_entity (object)
      || !(viewport = object->tio.entity->tio.VIEWPORT))
    return 1;
  /*
   * Viewport 1 is AutoCAD's implicit paper-space viewport and has no frame.
   * A non-rectangular viewport uses its referenced boundary entity, which is
   * already emitted through the normal primitive path; drawing its fallback
   * rectangle would expose geometry that AutoCAD intentionally hides.
   */
  if (is_primary_paper_viewport (dwg, object, viewport, tables)
      || reference_handle (viewport->clip_boundary) != 0)
    return 1;
  if (!isfinite (viewport->width) || !isfinite (viewport->height)
      || viewport->width <= 1.0e-9 || viewport->height <= 1.0e-9
      || !finite_point3 (viewport->center)
      || !initialize_entity_segment (object, tables, 11u, 0, &base))
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  half_width = viewport->width * 0.5;
  half_height = viewport->height * 0.5;
  points[0][0] = viewport->center.x - half_width;
  points[0][1] = viewport->center.y - half_height;
  points[1][0] = viewport->center.x + half_width;
  points[1][1] = viewport->center.y - half_height;
  points[2][0] = viewport->center.x + half_width;
  points[2][1] = viewport->center.y + half_height;
  points[3][0] = viewport->center.x - half_width;
  points[3][1] = viewport->center.y + half_height;
  for (index = 0; index < 4; index++)
    points[index][2] = viewport->center.z;
  for (index = 0; index < 4; index++)
    {
      LineSegment segment = base;
      memcpy (segment.start, points[index], sizeof (segment.start));
      memcpy (segment.end, points[(index + 1) % 4],
              sizeof (segment.end));
      if (!segment_iteration_emit (iteration, &segment))
        return 0;
    }
  return 1;
}

static int
group_rank_compare (const void *left, const void *right)
{
  const GroupRank *a = (const GroupRank *)left;
  const GroupRank *b = (const GroupRank *)right;
  if (a->value > b->value)
    return -1;
  if (a->value < b->value)
    return 1;
  return a->index < b->index ? -1 : a->index > b->index;
}

static int
initialize_overview_plan (const CacheTables *tables, OverviewPlan *plan)
{
  memset (plan, 0, sizeof (*plan));
  if (tables->block_count == SIZE_MAX)
    return 0;
  plan->group_count = tables->block_count + 1;
  if (plan->group_count > SIZE_MAX / sizeof (OverviewGroup))
    return 0;
  plan->groups
      = (OverviewGroup *)calloc (plan->group_count, sizeof (OverviewGroup));
  return plan->groups != NULL;
}

static void
free_overview_plan (OverviewPlan *plan)
{
  free (plan->groups);
  memset (plan, 0, sizeof (*plan));
}

static size_t
overview_group_index (const LineSegment *segment,
                      const OverviewPlan *plan)
{
  return segment->group == UINT32_MAX ? plan->group_count - 1
                                     : (size_t)segment->group;
}

static int
finalize_overview_quotas (OverviewPlan *plan)
{
  GroupRank *ranks = NULL;
  uint64_t total = 0;
  uint64_t nonempty = 0;
  uint64_t remaining;
  uint64_t capacity_total;
  uint64_t allocated = 0;
  size_t rank_count = 0;
  size_t i;

  for (i = 0; i < plan->group_count; i++)
    {
      if (UINT64_MAX - total < plan->groups[i].count)
        return 0;
      total += plan->groups[i].count;
      if (plan->groups[i].count)
        nonempty++;
    }
  if (total <= SCENE_OVERVIEW_SEGMENTS)
    {
      for (i = 0; i < plan->group_count; i++)
        plan->groups[i].quota = plan->groups[i].count;
      plan->quota_total = total;
      return 1;
    }

  if (nonempty > SIZE_MAX / sizeof (GroupRank))
    return 0;
  ranks = (GroupRank *)malloc ((size_t)nonempty * sizeof (GroupRank));
  if (!ranks)
    return 0;
  for (i = 0; i < plan->group_count; i++)
    {
      if (!plan->groups[i].count)
        continue;
      ranks[rank_count].value = plan->groups[i].count;
      ranks[rank_count].index = i;
      rank_count++;
    }

  if (nonempty > SCENE_OVERVIEW_SEGMENTS)
    {
      qsort (ranks, rank_count, sizeof (GroupRank), group_rank_compare);
      for (i = 0; i < SCENE_OVERVIEW_SEGMENTS; i++)
        plan->groups[ranks[i].index].quota = 1;
      plan->quota_total = SCENE_OVERVIEW_SEGMENTS;
      free (ranks);
      return 1;
    }

  for (i = 0; i < rank_count; i++)
    plan->groups[ranks[i].index].quota = 1;
  remaining = SCENE_OVERVIEW_SEGMENTS - nonempty;
  capacity_total = total - nonempty;
  for (i = 0; i < rank_count; i++)
    {
      OverviewGroup *group = &plan->groups[ranks[i].index];
      uint64_t capacity = group->count - 1;
      uint64_t product;
      uint64_t extra;
      if (remaining && capacity > UINT64_MAX / remaining)
        {
          free (ranks);
          return 0;
        }
      product = remaining * capacity;
      extra = product / capacity_total;
      group->quota += extra;
      allocated += extra;
      ranks[i].value = product % capacity_total;
    }
  qsort (ranks, rank_count, sizeof (GroupRank), group_rank_compare);
  for (i = 0; i < (size_t)(remaining - allocated); i++)
    plan->groups[ranks[i].index].quota++;
  plan->quota_total = SCENE_OVERVIEW_SEGMENTS;
  free (ranks);
  return 1;
}

static void
reset_overview_plan (OverviewPlan *plan)
{
  size_t i;
  for (i = 0; i < plan->group_count; i++)
    {
      plan->groups[i].seen = 0;
      plan->groups[i].emitted = 0;
    }
}

static uint64_t
overview_sample_index (uint64_t sample, uint64_t count, uint64_t quota)
{
  uint64_t span;
  uint64_t denominator;
  if (quota <= 1)
    return count / 2;
  span = count - 1;
  denominator = quota - 1;
  return (span / denominator) * sample
         + ((span % denominator) * sample) / denominator;
}

static int
overview_select (OverviewPlan *plan, const LineSegment *segment)
{
  size_t index = overview_group_index (segment, plan);
  OverviewGroup *group;
  uint64_t position;
  uint64_t target;
  if (index >= plan->group_count)
    return 0;
  group = &plan->groups[index];
  position = group->seen++;
  if (group->emitted >= group->quota)
    return 0;
  target = overview_sample_index (group->emitted, group->count,
                                  group->quota);
  if (position != target)
    return 0;
  group->emitted++;
  return 1;
}

static int
segment_iteration_emit (SegmentIteration *iteration,
                        const LineSegment *segment)
{
  LineSegment styled;
  double length_squared = 0.0;
  double scale;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (segment->start[axis])
          || !isfinite (segment->end[axis]))
        {
          iteration->skipped++;
          return 1;
        }
      length_squared
          += (segment->end[axis] - segment->start[axis])
             * (segment->end[axis] - segment->start[axis]);
    }
  styled = *segment;
  scale = isfinite (segment->linetype_scale)
                  && segment->linetype_scale > 1.0e-12
              ? segment->linetype_scale
              : 1.0;
  if (
      !iteration->has_pattern_end
      || iteration->pattern_handle != segment->handle
      || fabs (iteration->pattern_end_point[0] - segment->start[0])
             > 1.0e-7
      || fabs (iteration->pattern_end_point[1] - segment->start[1])
             > 1.0e-7
      || fabs (iteration->pattern_end_point[2] - segment->start[2])
             > 1.0e-7)
    iteration->pattern_cursor = 0.0;
  styled.pattern_start = iteration->pattern_cursor / scale;
  if (isfinite (length_squared) && length_squared > 0.0)
    iteration->pattern_cursor += sqrt (length_squared);
  styled.pattern_end = iteration->pattern_cursor / scale;
  iteration->pattern_handle = segment->handle;
  memcpy (iteration->pattern_end_point, segment->end,
          sizeof (iteration->pattern_end_point));
  iteration->has_pattern_end = 1;
  if (segment->approximated_curve)
    iteration->approximated++;
  if (iteration->overview
      && !overview_select (iteration->overview, &styled))
    return 1;
  if (!iteration->consumer (
          iteration->consumer_context, &styled))
    return 0;
  iteration->emitted++;
  return 1;
}

static void
segment_iteration_reject (SegmentIteration *iteration)
{
  iteration->skipped++;
}

static unsigned
bounded_curve_segment_count (double sweep, double maximum_angle,
                             unsigned maximum_segments)
{
  double requested;
  if (!isfinite (sweep) || fabs (sweep) <= CURVE_EPSILON
      || !isfinite (maximum_angle)
      || maximum_angle <= CURVE_EPSILON || !maximum_segments)
    return 0;
  requested = ceil (fabs (sweep) / maximum_angle);
  if (!isfinite (requested) || requested < 1.0)
    return 0;
  if (requested > (double)maximum_segments)
    return maximum_segments;
  return (unsigned)requested;
}

static unsigned
curve_segment_count (double sweep)
{
  return bounded_curve_segment_count (
      sweep, CURVE_MAX_ANGLE_RADIANS, MAX_CIRCULAR_SEGMENTS);
}

static unsigned
hatch_curve_segment_count (double sweep)
{
  return bounded_curve_segment_count (
      sweep, HATCH_CURVE_MAX_ANGLE_RADIANS,
      MAX_HATCH_CIRCULAR_SEGMENTS);
}

static int
normalized_curve_sweep (double start, double end, double *sweep)
{
  double raw;
  double normalized;
  if (!sweep || !isfinite (start) || !isfinite (end))
    return 0;
  raw = end - start;
  if (fabs (raw) >= CURVE_FULL_TURN_RADIANS - CURVE_EPSILON)
    {
      *sweep = CURVE_FULL_TURN_RADIANS;
      return 1;
    }
  normalized = fmod (raw, CURVE_FULL_TURN_RADIANS);
  if (normalized < 0.0)
    normalized += CURVE_FULL_TURN_RADIANS;
  if (!isfinite (normalized) || normalized <= CURVE_EPSILON)
    return 0;
  *sweep = normalized;
  return 1;
}

static unsigned
bulge_segment_count (double bulge)
{
  double sweep;
  unsigned requested;
  if (!isfinite (bulge) || fabs (bulge) <= CURVE_EPSILON)
    return 1;
  sweep = fabs (4.0 * atan (bulge));
  requested = curve_segment_count (sweep);
  return requested ? requested : 1u;
}

static unsigned
hatch_bulge_segment_count (double bulge)
{
  double sweep;
  unsigned requested;
  if (!isfinite (bulge) || fabs (bulge) <= CURVE_EPSILON)
    return 1;
  sweep = fabs (4.0 * atan (bulge));
  requested = hatch_curve_segment_count (sweep);
  return requested ? requested : 1u;
}

static int
bulge_point (const PolylineVertex *start, const PolylineVertex *end,
             double elevation, unsigned subdivision,
             unsigned subdivisions, double point[3])
{
  double fraction;
  double delta_x;
  double delta_y;
  double chord;
  double center_offset;
  double center_x;
  double center_y;
  double radius;
  double start_angle;
  double angle;
  if (!subdivisions || subdivision > subdivisions
      || !isfinite (start->bulge))
    return 0;
  fraction = (double)subdivision / (double)subdivisions;
  if (fabs (start->bulge) <= CURVE_EPSILON)
    {
      point[0] = start->position[0]
                 + (end->position[0] - start->position[0]) * fraction;
      point[1] = start->position[1]
                 + (end->position[1] - start->position[1]) * fraction;
      point[2] = elevation;
      return 1;
    }
  delta_x = end->position[0] - start->position[0];
  delta_y = end->position[1] - start->position[1];
  chord = hypot (delta_x, delta_y);
  if (!isfinite (chord))
    return 0;
  if (chord <= CURVE_EPSILON)
    {
      point[0] = start->position[0];
      point[1] = start->position[1];
      point[2] = elevation;
      return 1;
    }
  center_offset
      = chord * (1.0 - start->bulge * start->bulge)
        / (4.0 * start->bulge);
  center_x = (start->position[0] + end->position[0]) * 0.5
             - delta_y / chord * center_offset;
  center_y = (start->position[1] + end->position[1]) * 0.5
             + delta_x / chord * center_offset;
  radius = hypot (start->position[0] - center_x,
                  start->position[1] - center_y);
  start_angle = atan2 (start->position[1] - center_y,
                       start->position[0] - center_x);
  angle = start_angle + 4.0 * atan (start->bulge) * fraction;
  point[0] = center_x + radius * cos (angle);
  point[1] = center_y + radius * sin (angle);
  point[2] = elevation;
  return 1;
}

static void
ocs_to_wcs (const double normal[3], const double point[3],
            double transformed[3])
{
  double n[3] = { normal[0], normal[1], normal[2] };
  double x_axis[3];
  double y_axis[3];
  double length = sqrt (n[0] * n[0] + n[1] * n[1]
                        + n[2] * n[2]);
  double axis_length;
  if (!isfinite (length) || length <= 1.0e-12)
    {
      memcpy (transformed, point, 3 * sizeof (double));
      return;
    }
  n[0] /= length;
  n[1] /= length;
  n[2] /= length;
  if (fabs (n[0]) < 1.0 / 64.0 && fabs (n[1]) < 1.0 / 64.0)
    {
      x_axis[0] = n[2];
      x_axis[1] = 0.0;
      x_axis[2] = -n[0];
    }
  else
    {
      x_axis[0] = -n[1];
      x_axis[1] = n[0];
      x_axis[2] = 0.0;
    }
  axis_length = sqrt (x_axis[0] * x_axis[0]
                      + x_axis[1] * x_axis[1]
                      + x_axis[2] * x_axis[2]);
  if (!isfinite (axis_length) || axis_length <= 1.0e-12)
    {
      memcpy (transformed, point, 3 * sizeof (double));
      return;
    }
  x_axis[0] /= axis_length;
  x_axis[1] /= axis_length;
  x_axis[2] /= axis_length;
  y_axis[0] = n[1] * x_axis[2] - n[2] * x_axis[1];
  y_axis[1] = n[2] * x_axis[0] - n[0] * x_axis[2];
  y_axis[2] = n[0] * x_axis[1] - n[1] * x_axis[0];
  transformed[0] = x_axis[0] * point[0] + y_axis[0] * point[1]
                   + n[0] * point[2];
  transformed[1] = x_axis[1] * point[0] + y_axis[1] * point[1]
                   + n[1] * point[2];
  transformed[2] = x_axis[2] * point[0] + y_axis[2] * point[1]
                   + n[2] * point[2];
}

typedef struct
{
  const Dwg_Object *object;
  const CacheTables *tables;
  const PolylineInfo *info;
  SegmentIteration *iteration;
  PolylineVertex first;
  PolylineVertex previous;
  uint64_t count;
  int has_previous;
  int use_spline_fit_vertices;
} PolylineSegmentBuilder;

typedef struct
{
  uint64_t generated;
} PolylineFitVertexCount;

static int
is_spline_fit_display_vertex (const PolylineVertex *vertex)
{
  return vertex
         && (vertex->flags
             & (VERTEX_FLAG_CURVE_FIT_EXTRA
                | VERTEX_FLAG_SPLINE_FIT_EXTRA))
         && !(vertex->flags & VERTEX_FLAG_SPLINE_FRAME_CONTROL);
}

static int
count_spline_fit_display_vertex (void *context,
                                 const PolylineVertex *vertex)
{
  PolylineFitVertexCount *count = (PolylineFitVertexCount *)context;
  if (is_spline_fit_display_vertex (vertex))
    count->generated++;
  return 1;
}

static void
initialize_polyline_segment (const PolylineSegmentBuilder *builder,
                             LineSegment *segment)
{
  const Dwg_Object_Entity *entity = builder->object->tio.entity;
  int line_weight = dxf_cvt_lweight (entity->linewt);
  memset (segment, 0, sizeof (*segment));
  if (line_weight < INT16_MIN || line_weight > INT16_MAX)
    line_weight = -1;
  segment->handle = (uint64_t)builder->object->handle.value;
  segment->layer_index = entity_layer_index (entity, builder->tables);
  segment->color = encode_entity_color (&entity->color);
  segment->line_weight = (int16_t)line_weight;
  segment->flags = entity->invisible ? 1u : 0u;
  segment->group = entity_group (entity, builder->tables);
  segment->source_kind = (uint8_t)builder->info->kind;
  segment->linetype_code
      = entity_linetype_code (entity, builder->tables);
  segment->linetype_scale
      = isfinite (entity->ltype_scale)
                && fabs (entity->ltype_scale) > 1.0e-12
            ? fabs (entity->ltype_scale)
            : 1.0;
}

static int
emit_polyline_edge (PolylineSegmentBuilder *builder,
                    const PolylineVertex *start,
                    const PolylineVertex *end)
{
  unsigned subdivisions
      = builder->info->kind == 3
            ? 1u
            : bulge_segment_count (start->bulge);
  unsigned index;
  if (!(builder->info->flags & POLYLINE_FLAG_CONTINUOUS_LINETYPE))
    {
      builder->iteration->has_pattern_end = 0;
      builder->iteration->pattern_cursor = 0.0;
    }
  for (index = 0; index < subdivisions; index++)
    {
      LineSegment segment;
      initialize_polyline_segment (builder, &segment);
      if (builder->info->kind == 3)
        {
          memcpy (segment.start, start->position,
                  3 * sizeof (double));
          memcpy (segment.end, end->position, 3 * sizeof (double));
        }
      else
        {
          double start_ocs[3];
          double end_ocs[3];
          if (!bulge_point (start, end, builder->info->elevation,
                            index, subdivisions, start_ocs)
              || !bulge_point (start, end, builder->info->elevation,
                               index + 1u, subdivisions, end_ocs))
            {
              segment_iteration_reject (builder->iteration);
              continue;
            }
          ocs_to_wcs (builder->info->normal, start_ocs,
                      segment.start);
          ocs_to_wcs (builder->info->normal, end_ocs, segment.end);
          segment.approximated_curve
              = isfinite (start->bulge)
                && fabs (start->bulge) > CURVE_EPSILON;
        }
      if (!segment_iteration_emit (builder->iteration, &segment))
        return 0;
    }
  return 1;
}

static int
polyline_segment_vertex (void *context, const PolylineVertex *vertex)
{
  PolylineSegmentBuilder *builder
      = (PolylineSegmentBuilder *)context;
  if (builder->use_spline_fit_vertices
      && !is_spline_fit_display_vertex (vertex))
    return 1;
  if (!builder->has_previous)
    {
      builder->first = *vertex;
      builder->previous = *vertex;
      builder->has_previous = 1;
    }
  else
    {
      if (!emit_polyline_edge (builder, &builder->previous, vertex))
        return 0;
      builder->previous = *vertex;
    }
  builder->count++;
  return 1;
}

static int
iterate_polyline_segments (const Dwg_Object *object,
                           const CacheTables *tables,
                           SegmentIteration *iteration)
{
  PolylineInfo info;
  PolylineSegmentBuilder builder;
  if (!read_polyline_info (object, &info))
    return 1;
  if (entity_group (object->tio.entity, tables) == UINT32_MAX - 1u)
    return 1;
  memset (&builder, 0, sizeof (builder));
  builder.object = object;
  builder.tables = tables;
  builder.info = &info;
  builder.iteration = iteration;
  if (info.kind == 2 && (info.flags & POLYLINE_FLAG_SPLINE_FIT))
    {
      PolylineFitVertexCount fit_count;
      memset (&fit_count, 0, sizeof (fit_count));
      if (!iterate_polyline_vertices (
              object, count_spline_fit_display_vertex, &fit_count,
              NULL))
        return 0;
      builder.use_spline_fit_vertices = fit_count.generated >= 2;
    }
  if (!iterate_polyline_vertices (
          object, polyline_segment_vertex, &builder, NULL))
    return 0;
  if (info.closed && builder.count > 1
      && !emit_polyline_edge (
          &builder, &builder.previous, &builder.first))
    return 0;
  return 1;
}

typedef struct
{
  double (*points)[3];
  size_t capacity;
  size_t count;
  int invalid;
} MeshPointCollector;

static void
collect_mesh_vertex (MeshPointCollector *collector,
                     const Dwg_Object *vertex_object)
{
  const Dwg_Entity_VERTEX_MESH *vertex = NULL;
  if (!collector || !vertex_object || !vertex_object->tio.entity)
    return;
  if (vertex_object->fixedtype == DWG_TYPE_VERTEX_MESH)
    vertex = vertex_object->tio.entity->tio.VERTEX_MESH;
  else if (vertex_object->fixedtype == DWG_TYPE_VERTEX_3D)
    vertex = vertex_object->tio.entity->tio.VERTEX_3D;
  if (!vertex)
    return;
  if (collector->count >= collector->capacity)
    {
      collector->invalid = 1;
      return;
    }
  collector->points[collector->count][0] = vertex->point.x;
  collector->points[collector->count][1] = vertex->point.y;
  collector->points[collector->count][2] = vertex->point.z;
  if (!isfinite (vertex->point.x) || !isfinite (vertex->point.y)
      || !isfinite (vertex->point.z))
    collector->invalid = 1;
  collector->count++;
}

static void
collect_mesh_vertices (const Dwg_Object *object,
                       const Dwg_Entity_POLYLINE_MESH *mesh,
                       MeshPointCollector *collector)
{
  const Dwg_Data *dwg = object ? object->parent : NULL;
  uint64_t visited = 0;
  uint64_t limit;
  if (!dwg || !mesh || !collector)
    {
      if (collector)
        collector->invalid = 1;
      return;
    }
  limit = (uint64_t)dwg->num_objects;
  if (dwg->header.version < R_13b1)
    {
      Dwg_Object *current = dwg_next_object (object);
      while (current && visited < limit
             && current->fixedtype != DWG_TYPE_SEQEND)
        {
          collect_mesh_vertex (collector, current);
          current = dwg_next_object (current);
          visited++;
        }
    }
  else if (dwg->header.version <= R_2000)
    {
      Dwg_Object *current
          = mesh->first_vertex
                ? reference_object (dwg, mesh->first_vertex)
                : NULL;
      while (current && visited < limit)
        {
          collect_mesh_vertex (collector, current);
          visited++;
          if (mesh->last_vertex && current == mesh->last_vertex->obj)
            break;
          current = dwg_next_object (current);
          if (!current || current->fixedtype == DWG_TYPE_SEQEND)
            break;
        }
    }
  else if (mesh->vertex)
    {
      uint64_t declared = (uint64_t)mesh->num_owned;
      if (declared < limit)
        limit = declared;
      for (visited = 0; visited < limit; visited++)
        collect_mesh_vertex (
            collector,
            mesh->vertex[visited]
                ? reference_object (dwg, mesh->vertex[visited])
                : NULL);
    }
}

static int
emit_mesh_edge (SegmentIteration *iteration, const LineSegment *base,
                const double start[3], const double end[3],
                uint64_t *generated)
{
  return emit_mleader_segment (
      iteration, base, start, end, 0, generated);
}

static int
iterate_polyline_mesh_segments (const Dwg_Object *object,
                                const CacheTables *tables,
                                SegmentIteration *iteration)
{
  const Dwg_Entity_POLYLINE_MESH *mesh;
  MeshPointCollector collector;
  LineSegment base;
  size_t m_count;
  size_t n_count;
  size_t expected;
  size_t m;
  size_t n;
  uint64_t generated = 0;
  if (!object || object->fixedtype != DWG_TYPE_POLYLINE_MESH
      || !object->tio.entity
      || !(mesh = object->tio.entity->tio.POLYLINE_MESH))
    return 1;
  if (mesh->num_m_verts <= 0 || mesh->num_n_verts <= 0
      || !object->parent)
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  m_count = (size_t)mesh->num_m_verts;
  n_count = (size_t)mesh->num_n_verts;
  if (m_count > SIZE_MAX / n_count)
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  expected = m_count * n_count;
  /*
   * A surface-fit polygon mesh stores the generated density grid rather
   * than the original control grid. Prefer those dimensions only when the
   * owned vertex count confirms the complete grid.
   */
  if (mesh->curve_type != 0 && mesh->m_density > 0
      && mesh->n_density > 0
      && (size_t)mesh->m_density <= SIZE_MAX / (size_t)mesh->n_density
      && (size_t)mesh->m_density * (size_t)mesh->n_density
             == (size_t)mesh->num_owned)
    {
      m_count = (size_t)mesh->m_density;
      n_count = (size_t)mesh->n_density;
      expected = m_count * n_count;
    }
  if (expected < 2 || expected > (size_t)object->parent->num_objects
      || expected > SIZE_MAX / sizeof (*collector.points))
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  memset (&collector, 0, sizeof (collector));
  collector.capacity = expected;
  collector.points
      = (double (*)[3])malloc (expected * sizeof (*collector.points));
  if (!collector.points)
    return 0;
  collect_mesh_vertices (object, mesh, &collector);
  if (collector.invalid || collector.count != expected
      || !initialize_entity_segment (object, tables, 14u, 0, &base))
    {
      free (collector.points);
      segment_iteration_reject (iteration);
      return 1;
    }
  /* Vertices are ordered as M groups containing N consecutive vertices. */
  for (m = 0; m < m_count; m++)
    for (n = 0; n < n_count; n++)
      {
        size_t index = m * n_count + n;
        if (n + 1 < n_count
            && !emit_mesh_edge (
                iteration, &base, collector.points[index],
                collector.points[index + 1], &generated))
          goto emit_failed;
        if (m + 1 < m_count
            && !emit_mesh_edge (
                iteration, &base, collector.points[index],
                collector.points[index + n_count], &generated))
          goto emit_failed;
      }
  if ((mesh->flag & 1u) != 0u)
    for (n = 0; n < n_count; n++)
      if (!emit_mesh_edge (
              iteration, &base,
              collector.points[(m_count - 1) * n_count + n],
              collector.points[n], &generated))
        goto emit_failed;
  if ((mesh->flag & 32u) != 0u)
    for (m = 0; m < m_count; m++)
      if (!emit_mesh_edge (
              iteration, &base,
              collector.points[m * n_count + n_count - 1],
              collector.points[m * n_count], &generated))
        goto emit_failed;
  free (collector.points);
  return 1;

emit_failed:
  free (collector.points);
  return 0;
}

static int
normalize_mline_vector (const BITCODE_3BD source, double result[3])
{
  double length
      = hypot (hypot (source.x, source.y), source.z);
  if (!isfinite (length) || length <= 1.0e-12)
    return 0;
  result[0] = source.x / length;
  result[1] = source.y / length;
  result[2] = source.z / length;
  return 1;
}

static int
mline_element_intersection (const Dwg_MLINE_vertex *vertex,
                            size_t line_index, double point[3])
{
  const Dwg_MLINE_line *line;
  double miter[3];
  double distance;
  if (!vertex || !vertex->lines
      || line_index >= (size_t)vertex->num_lines
      || !(line = &vertex->lines[line_index])
      || line->num_segparms <= 0 || !line->segparms
      || !finite_point3 (vertex->vertex)
      || !normalize_mline_vector (vertex->miter_direction, miter))
    return 0;
  distance = line->segparms[0];
  if (!isfinite (distance))
    return 0;
  point[0] = vertex->vertex.x + miter[0] * distance;
  point[1] = vertex->vertex.y + miter[1] * distance;
  point[2] = vertex->vertex.z + miter[2] * distance;
  return 1;
}

static int
mline_element_start (const Dwg_MLINE_vertex *vertex,
                     size_t line_index, double point[3])
{
  const Dwg_MLINE_line *line;
  double direction[3];
  double distance;
  size_t axis;
  if (!mline_element_intersection (vertex, line_index, point)
      || !(line = &vertex->lines[line_index]))
    return 0;
  if (line->num_segparms < 2)
    return 1;
  if (!normalize_mline_vector (vertex->vertex_direction, direction)
      || !isfinite (line->segparms[1]))
    return 0;
  distance = line->segparms[1];
  for (axis = 0; axis < 3; axis++)
    point[axis] += direction[axis] * distance;
  return 1;
}

static const Dwg_Object_MLINESTYLE *
resolve_mline_style (const Dwg_Object *object,
                     const Dwg_Entity_MLINE *mline)
{
  Dwg_Object *style_object;
  if (!object || !object->parent || !mline || !mline->mlinestyle)
    return NULL;
  style_object
      = reference_object (object->parent, mline->mlinestyle);
  if (!style_object || style_object->fixedtype != DWG_TYPE_MLINESTYLE
      || !style_object->tio.object)
    return NULL;
  return style_object->tio.object->tio.MLINESTYLE;
}

static void
apply_mline_element_style (const Dwg_Object_MLINESTYLE *style,
                           size_t line_index,
                           const CacheTables *tables,
                           LineSegment *segment)
{
  const Dwg_MLINESTYLE_line *line;
  uint32_t linetype_code;
  if (!style || !style->lines
      || line_index >= (size_t)style->num_lines)
    return;
  line = &style->lines[line_index];
  segment->color = encode_color (&line->color);
  if (!line->lt_ltype)
    return;
  linetype_code = find_handle_index (
      tables->linetype_codes, tables->linetype_code_count,
      reference_handle (line->lt_ltype));
  if (linetype_code != UINT32_MAX)
    segment->linetype_code = (uint16_t)linetype_code;
}

static int
emit_mline_round_cap (SegmentIteration *iteration,
                      const LineSegment *base, const double first[3],
                      const double last[3], const double outward[3],
                      uint64_t *generated)
{
  double center[3];
  double across[3];
  double bulge[3];
  double radius;
  double projection;
  double bulge_length;
  double previous[3];
  size_t axis;
  size_t chord;
  const size_t chords = 12;
  for (axis = 0; axis < 3; axis++)
    {
      center[axis] = (first[axis] + last[axis]) * 0.5;
      across[axis] = first[axis] - center[axis];
    }
  radius = hypot (hypot (across[0], across[1]), across[2]);
  if (!isfinite (radius) || radius <= 1.0e-12)
    return 1;
  for (axis = 0; axis < 3; axis++)
    across[axis] /= radius;
  projection = outward[0] * across[0] + outward[1] * across[1]
               + outward[2] * across[2];
  for (axis = 0; axis < 3; axis++)
    bulge[axis] = outward[axis] - across[axis] * projection;
  bulge_length = hypot (hypot (bulge[0], bulge[1]), bulge[2]);
  if (!isfinite (bulge_length) || bulge_length <= 1.0e-12)
    {
      bulge[0] = -across[1];
      bulge[1] = across[0];
      bulge[2] = 0.0;
      bulge_length = hypot (bulge[0], bulge[1]);
    }
  if (!isfinite (bulge_length) || bulge_length <= 1.0e-12)
    return 1;
  for (axis = 0; axis < 3; axis++)
    {
      bulge[axis] /= bulge_length;
      previous[axis] = first[axis];
    }
  for (chord = 1; chord <= chords; chord++)
    {
      double angle = acos (-1.0) * (double)chord / (double)chords;
      double point[3];
      for (axis = 0; axis < 3; axis++)
        point[axis] = center[axis]
                      + radius
                            * (across[axis] * cos (angle)
                               + bulge[axis] * sin (angle));
      if (!emit_mleader_segment (
              iteration, base, previous, point, 1, generated))
        return 0;
      memcpy (previous, point, sizeof (previous));
    }
  return 1;
}

static int
emit_mline_cap (const Dwg_Entity_MLINE *mline,
                const Dwg_Object_MLINESTYLE *style,
                const CacheTables *tables, SegmentIteration *iteration,
                const LineSegment *entity_base, size_t vertex_index,
                int is_start, uint64_t *generated)
{
  const Dwg_MLINE_vertex *vertex = &mline->verts[vertex_index];
  double endpoints[256][3];
  double outward[3];
  size_t line_count = (size_t)mline->num_lines;
  size_t line_index;
  uint32_t square_flag = is_start ? 16u : 256u;
  uint32_t inner_arc_flag = is_start ? 32u : 512u;
  uint32_t outer_arc_flag = is_start ? 64u : 1024u;
  if (!style || line_count < 2 || !vertex->lines
      || line_count > sizeof (endpoints) / sizeof (endpoints[0]))
    return 1;
  if (line_count > (size_t)vertex->num_lines)
    line_count = (size_t)vertex->num_lines;
  if (line_count > (size_t)style->num_lines)
    line_count = (size_t)style->num_lines;
  if (line_count < 2)
    return 1;
  for (line_index = 0; line_index < line_count; line_index++)
    if (!(is_start
              ? mline_element_start (
                    vertex, line_index, endpoints[line_index])
              : mline_element_intersection (
                    vertex, line_index, endpoints[line_index])))
      return 1;
  if (!normalize_mline_vector (vertex->vertex_direction, outward))
    return 1;
  if (is_start)
    for (line_index = 0; line_index < 3; line_index++)
      outward[line_index] = -outward[line_index];
  if (((uint32_t)style->flag & square_flag) != 0u)
    {
      LineSegment cap = *entity_base;
      if (!emit_mleader_segment (
              iteration, &cap, endpoints[0],
              endpoints[line_count - 1], 0, generated))
        return 0;
    }
  if (((uint32_t)style->flag & inner_arc_flag) != 0u)
    for (line_index = 0; line_index + 1 < line_count; line_index++)
      {
        LineSegment cap = *entity_base;
        apply_mline_element_style (style, line_index, tables, &cap);
        if (!emit_mline_round_cap (
                iteration, &cap, endpoints[line_index],
                endpoints[line_index + 1], outward, generated))
          return 0;
      }
  if (((uint32_t)style->flag & outer_arc_flag) != 0u)
    {
      LineSegment cap = *entity_base;
      if (!emit_mline_round_cap (
              iteration, &cap, endpoints[0],
              endpoints[line_count - 1], outward, generated))
        return 0;
    }
  return 1;
}

static int
iterate_mline_segments (const Dwg_Object *object,
                        const CacheTables *tables,
                        SegmentIteration *iteration)
{
  const Dwg_Entity_MLINE *mline;
  const Dwg_Object_MLINESTYLE *style;
  LineSegment entity_base;
  size_t vertex_count;
  size_t line_count;
  size_t segment_count;
  size_t vertex_index;
  size_t line_index;
  uint64_t generated = 0;
  if (!object || object->fixedtype != DWG_TYPE_MLINE
      || !object->tio.entity
      || !(mline = object->tio.entity->tio.MLINE))
    return 1;
  if (mline->num_verts < 2 || mline->num_lines == 0 || !mline->verts
      || !initialize_entity_segment (object, tables, 15u, 0,
                                     &entity_base))
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  vertex_count = (size_t)mline->num_verts;
  line_count = (size_t)mline->num_lines;
  style = resolve_mline_style (object, mline);
  if (style && line_count > (size_t)style->num_lines)
    line_count = (size_t)style->num_lines;
  if (line_count == 0
      || vertex_count > SIZE_MAX / line_count
      || vertex_count * line_count
             > MAX_MULTILEADER_SEGMENTS_PER_ENTITY)
    {
      segment_iteration_reject (iteration);
      return 1;
    }
  segment_count
      = ((uint32_t)mline->flags & 2u) != 0u
            ? vertex_count
            : vertex_count - 1;
  for (vertex_index = 0; vertex_index < segment_count; vertex_index++)
    {
      const Dwg_MLINE_vertex *vertex = &mline->verts[vertex_index];
      const Dwg_MLINE_vertex *next
          = &mline->verts[(vertex_index + 1) % vertex_count];
      size_t usable_lines = line_count;
      if (usable_lines > (size_t)vertex->num_lines)
        usable_lines = (size_t)vertex->num_lines;
      if (usable_lines > (size_t)next->num_lines)
        usable_lines = (size_t)next->num_lines;
      for (line_index = 0; line_index < usable_lines; line_index++)
        {
          const Dwg_MLINE_line *line = &vertex->lines[line_index];
          LineSegment base = entity_base;
          double start[3];
          double end[3];
          double intersection[3];
          double direction[3];
          size_t parameter_index;
          size_t axis;
          if (line->num_segparms < 2 || !line->segparms
              || !mline_element_start (vertex, line_index, start)
              || !mline_element_intersection (
                  vertex, line_index, intersection)
              || !mline_element_intersection (next, line_index, end)
              || !normalize_mline_vector (
                  vertex->vertex_direction, direction))
            continue;
          apply_mline_element_style (style, line_index, tables, &base);
          for (parameter_index = 2;
               parameter_index < (size_t)line->num_segparms;
               parameter_index++)
            {
              double boundary_distance;
              double boundary[3];
              if (!isfinite (line->segparms[parameter_index]))
                break;
              boundary_distance
                  = line->segparms[1]
                    + line->segparms[parameter_index];
              for (axis = 0; axis < 3; axis++)
                boundary[axis]
                    = intersection[axis]
                      + direction[axis] * boundary_distance;
              if ((parameter_index & 1u) == 0u)
                {
                  if (!emit_mleader_segment (
                          iteration, &base, start, boundary, 0,
                          &generated))
                    return 0;
                }
              else
                memcpy (start, boundary, sizeof (start));
            }
          if (((size_t)line->num_segparms & 1u) == 0u
              && !emit_mleader_segment (
                  iteration, &base, start, end, 0, &generated))
            return 0;
        }
    }
  if (style && ((uint32_t)style->flag & 2u) != 0u)
    {
      size_t first_vertex
          = ((uint32_t)mline->flags & 2u) != 0u ? 0u : 1u;
      size_t last_vertex
          = ((uint32_t)mline->flags & 2u) != 0u
                ? vertex_count
                : vertex_count - 1u;
      for (vertex_index = first_vertex; vertex_index < last_vertex;
           vertex_index++)
        for (line_index = 0; line_index + 1 < line_count;
             line_index++)
          {
            double first[3];
            double last[3];
            if (mline_element_intersection (
                    &mline->verts[vertex_index], line_index, first)
                && mline_element_intersection (
                    &mline->verts[vertex_index], line_index + 1, last)
                && !emit_mleader_segment (
                    iteration, &entity_base, first, last, 0,
                    &generated))
              return 0;
          }
    }
  if (((uint32_t)mline->flags & 2u) == 0u)
    {
      if (((uint32_t)mline->flags & 4u) == 0u
          && !emit_mline_cap (
              mline, style, tables, iteration, &entity_base, 0u, 1,
              &generated))
        return 0;
      if (((uint32_t)mline->flags & 8u) == 0u
          && !emit_mline_cap (
              mline, style, tables, iteration, &entity_base,
              vertex_count - 1u, 0, &generated))
        return 0;
    }
  return 1;
}

static void
circular_ocs_point (const double center[3], double radius, double angle,
                    const double normal[3], double point[3])
{
  double ocs_point[3];
  ocs_point[0] = center[0] + radius * cos (angle);
  ocs_point[1] = center[1] + radius * sin (angle);
  ocs_point[2] = center[2];
  ocs_to_wcs (normal, ocs_point, point);
}

static int
ellipse_axes (const double major_axis[3], const double normal[3],
              double axis_ratio, double minor_axis[3])
{
  double major_length;
  double normal_length_squared;
  double normal_length;
  double unit_normal[3];
  double cross[3];
  double cross_length;
  double minor_length;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (major_axis[axis]) || !isfinite (normal[axis]))
        return 0;
    }
  if (!isfinite (axis_ratio) || fabs (axis_ratio) <= CURVE_EPSILON)
    return 0;
  major_length
      = hypot (hypot (major_axis[0], major_axis[1]), major_axis[2]);
  normal_length_squared = normal[0] * normal[0]
                          + normal[1] * normal[1]
                          + normal[2] * normal[2];
  if (!isfinite (major_length) || major_length <= CURVE_EPSILON
      || !isfinite (normal_length_squared)
      || normal_length_squared <= CURVE_EPSILON)
    return 0;
  normal_length = sqrt (normal_length_squared);
  unit_normal[0] = normal[0] / normal_length;
  unit_normal[1] = normal[1] / normal_length;
  unit_normal[2] = normal[2] / normal_length;
  cross[0] = unit_normal[1] * major_axis[2]
             - unit_normal[2] * major_axis[1];
  cross[1] = unit_normal[2] * major_axis[0]
             - unit_normal[0] * major_axis[2];
  cross[2] = unit_normal[0] * major_axis[1]
             - unit_normal[1] * major_axis[0];
  cross_length = hypot (hypot (cross[0], cross[1]), cross[2]);
  minor_length = major_length * fabs (axis_ratio);
  if (!isfinite (cross_length) || cross_length <= CURVE_EPSILON
      || !isfinite (minor_length))
    return 0;
  minor_axis[0] = cross[0] / cross_length * minor_length;
  minor_axis[1] = cross[1] / cross_length * minor_length;
  minor_axis[2] = cross[2] / cross_length * minor_length;
  return 1;
}

static void
ellipse_point (const double center[3], const double major_axis[3],
               const double minor_axis[3], double parameter,
               double point[3])
{
  double major_scale = cos (parameter);
  double minor_scale = sin (parameter);
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    point[axis] = center[axis] + major_axis[axis] * major_scale
                  + minor_axis[axis] * minor_scale;
}

static int
iterate_analytic_curve_segments (const Dwg_Object *object,
                                 const CacheTables *tables,
                                 SegmentIteration *iteration)
{
  LineSegment base;
  double center[3];
  double normal[3];
  double major_axis[3];
  double minor_axis[3];
  double start_parameter;
  double sweep;
  double radius;
  unsigned segment_count;
  unsigned index;
  if (!object || !object->tio.entity)
    return 1;
  if (object->fixedtype == DWG_TYPE_ARC
      && object->tio.entity->tio.ARC)
    {
      const Dwg_Entity_ARC *arc = object->tio.entity->tio.ARC;
      radius = arc->radius;
      start_parameter = arc->start_angle;
      if (!isfinite (radius) || fabs (radius) <= CURVE_EPSILON
          || !normalized_curve_sweep (
              start_parameter, arc->end_angle, &sweep))
        return 1;
      center[0] = arc->center.x;
      center[1] = arc->center.y;
      center[2] = arc->center.z;
      normal[0] = arc->extrusion.x;
      normal[1] = arc->extrusion.y;
      normal[2] = arc->extrusion.z;
      if (!initialize_entity_segment (object, tables, 4, 1, &base))
        return 1;
      segment_count = curve_segment_count (sweep);
      for (index = 0; index < segment_count; index++)
        {
          LineSegment segment = base;
          double start_angle
              = start_parameter
                + sweep * (double)index / (double)segment_count;
          double end_angle
              = start_parameter
                + sweep * (double)(index + 1u)
                      / (double)segment_count;
          circular_ocs_point (center, radius, start_angle, normal,
                              segment.start);
          circular_ocs_point (center, radius, end_angle, normal,
                              segment.end);
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_CIRCLE
      && object->tio.entity->tio.CIRCLE)
    {
      const Dwg_Entity_CIRCLE *circle
          = object->tio.entity->tio.CIRCLE;
      radius = circle->radius;
      if (!isfinite (radius) || fabs (radius) <= CURVE_EPSILON)
        return 1;
      center[0] = circle->center.x;
      center[1] = circle->center.y;
      center[2] = circle->center.z;
      normal[0] = circle->extrusion.x;
      normal[1] = circle->extrusion.y;
      normal[2] = circle->extrusion.z;
      if (!initialize_entity_segment (object, tables, 5, 1, &base))
        return 1;
      segment_count = curve_segment_count (CURVE_FULL_TURN_RADIANS);
      for (index = 0; index < segment_count; index++)
        {
          LineSegment segment = base;
          double start_angle
              = CURVE_FULL_TURN_RADIANS * (double)index
                / (double)segment_count;
          double end_angle
              = CURVE_FULL_TURN_RADIANS * (double)(index + 1u)
                / (double)segment_count;
          circular_ocs_point (center, radius, start_angle, normal,
                              segment.start);
          circular_ocs_point (center, radius, end_angle, normal,
                              segment.end);
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
      return 1;
    }
  if (object->fixedtype == DWG_TYPE_ELLIPSE
      && object->tio.entity->tio.ELLIPSE)
    {
      const Dwg_Entity_ELLIPSE *ellipse
          = object->tio.entity->tio.ELLIPSE;
      center[0] = ellipse->center.x;
      center[1] = ellipse->center.y;
      center[2] = ellipse->center.z;
      major_axis[0] = ellipse->sm_axis.x;
      major_axis[1] = ellipse->sm_axis.y;
      major_axis[2] = ellipse->sm_axis.z;
      normal[0] = ellipse->extrusion.x;
      normal[1] = ellipse->extrusion.y;
      normal[2] = ellipse->extrusion.z;
      start_parameter = ellipse->start_angle;
      if (!ellipse_axes (major_axis, normal, ellipse->axis_ratio,
                         minor_axis)
          || !normalized_curve_sweep (
              start_parameter, ellipse->end_angle, &sweep))
        return 1;
      if (!initialize_entity_segment (object, tables, 6, 1, &base))
        return 1;
      segment_count = curve_segment_count (sweep);
      for (index = 0; index < segment_count; index++)
        {
          LineSegment segment = base;
          double start
              = start_parameter
                + sweep * (double)index / (double)segment_count;
          double end
              = start_parameter
                + sweep * (double)(index + 1u)
                      / (double)segment_count;
          ellipse_point (center, major_axis, minor_axis, start,
                         segment.start);
          ellipse_point (center, major_axis, minor_axis, end,
                         segment.end);
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
    }
  return 1;
}

static int
read_spline_sampling (const Dwg_Entity_SPLINE *spline,
                      SplineSampling *sampling)
{
  size_t degree;
  size_t control_count;
  size_t knot_count;
  size_t required_knots;
  size_t nonzero_spans = 0;
  size_t requested_segments;
  size_t index;
  int has_nonzero_weight = 0;
  double domain_range;
  if (!spline || !sampling || spline->degree <= 0
      || (uint64_t)spline->degree > MAX_SPLINE_DEGREE)
    return 0;
  degree = (size_t)spline->degree;
  control_count = spline_control_point_count (spline);
  knot_count = spline_knot_count (spline);
  if (control_count <= degree
      || control_count > SIZE_MAX - degree - 1u)
    return 0;
  required_knots = control_count + degree + 1u;
  if (knot_count < required_knots)
    return 0;
  for (index = 0; index < knot_count; index++)
    {
      if (!isfinite (spline->knots[index])
          || (index && spline->knots[index - 1u]
                           > spline->knots[index]))
        return 0;
    }
  if (spline->weighted)
    {
      for (index = 0; index < control_count; index++)
        {
          double weight = spline->ctrl_pts[index].w;
          if (!isfinite (weight))
            return 0;
          if (fabs (weight) > CURVE_EPSILON)
            has_nonzero_weight = 1;
        }
      if (!has_nonzero_weight)
        return 0;
    }
  sampling->domain_start = spline->knots[degree];
  sampling->domain_end = spline->knots[control_count];
  domain_range = sampling->domain_end - sampling->domain_start;
  if (!isfinite (domain_range) || domain_range <= CURVE_EPSILON)
    return 0;
  for (index = degree; index < control_count; index++)
    {
      double span = spline->knots[index + 1u] - spline->knots[index];
      if (!isfinite (span))
        return 0;
      if (span > CURVE_EPSILON)
        nonzero_spans++;
    }
  if (!nonzero_spans)
    return 0;
  sampling->segments_per_span
      = degree == 1u ? 1u : SPLINE_SEGMENTS_PER_SPAN;
  if (nonzero_spans > SIZE_MAX / sampling->segments_per_span)
    return 0;
  requested_segments
      = nonzero_spans * sampling->segments_per_span;
  sampling->degree = degree;
  sampling->control_count = control_count;
  sampling->nonzero_spans = nonzero_spans;
  sampling->segment_count
      = requested_segments > MAX_SPLINE_SEGMENTS
            ? MAX_SPLINE_SEGMENTS
            : (unsigned)requested_segments;
  sampling->uniform_domain
      = requested_segments > MAX_SPLINE_SEGMENTS;
  return sampling->segment_count != 0;
}

static int
spline_segment_parameters (const Dwg_Entity_SPLINE *spline,
                           const SplineSampling *sampling,
                           unsigned segment_index, double *start,
                           double *end)
{
  size_t span_ordinal;
  size_t subdivision;
  size_t current_span = 0;
  size_t knot_index;
  if (!spline || !sampling || !start || !end
      || segment_index >= sampling->segment_count)
    return 0;
  if (sampling->uniform_domain)
    {
      double scale
          = (sampling->domain_end - sampling->domain_start)
            / (double)sampling->segment_count;
      *start = sampling->domain_start
               + scale * (double)segment_index;
      *end = sampling->domain_start
             + scale * (double)(segment_index + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  span_ordinal
      = (size_t)segment_index / sampling->segments_per_span;
  subdivision
      = (size_t)segment_index % sampling->segments_per_span;
  if (span_ordinal >= sampling->nonzero_spans)
    return 0;
  for (knot_index = sampling->degree;
       knot_index < sampling->control_count; knot_index++)
    {
      double span_start = spline->knots[knot_index];
      double span_end = spline->knots[knot_index + 1u];
      double scale;
      if (span_end - span_start <= CURVE_EPSILON)
        continue;
      if (current_span++ != span_ordinal)
        continue;
      scale
          = (span_end - span_start)
            / (double)sampling->segments_per_span;
      *start = span_start + scale * (double)subdivision;
      *end = span_start + scale * (double)(subdivision + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  return 0;
}

static int
evaluate_spline (const Dwg_Entity_SPLINE *spline,
                 const SplineSampling *sampling, double parameter,
                 double point[3])
{
  double points[MAX_SPLINE_DEGREE + 1u][3];
  double weights[MAX_SPLINE_DEGREE + 1u];
  size_t span = SIZE_MAX;
  size_t level;
  size_t index;
  size_t axis;
  if (!spline || !sampling || !point || !isfinite (parameter))
    return 0;
  if (parameter >= sampling->domain_end - CURVE_EPSILON)
    span = sampling->control_count - 1u;
  else
    {
      for (index = sampling->degree;
           index < sampling->control_count; index++)
        {
          if (spline->knots[index] <= parameter
              && parameter < spline->knots[index + 1u])
            {
              span = index;
              break;
            }
        }
    }
  if (span == SIZE_MAX || span < sampling->degree)
    return 0;
  for (index = 0; index <= sampling->degree; index++)
    {
      size_t control_index = span - sampling->degree + index;
      const Dwg_SPLINE_control_point *control
          = &spline->ctrl_pts[control_index];
      double weight = spline->weighted ? control->w : 1.0;
      if (!isfinite (control->x) || !isfinite (control->y)
          || !isfinite (control->z) || !isfinite (weight))
        return 0;
      points[index][0] = control->x * weight;
      points[index][1] = control->y * weight;
      points[index][2] = control->z * weight;
      weights[index] = weight;
    }
  for (level = 1; level <= sampling->degree; level++)
    {
      for (index = sampling->degree; index >= level; index--)
        {
          size_t knot_index
              = span - sampling->degree + index;
          double denominator
              = spline->knots[knot_index + sampling->degree - level
                              + 1u]
                - spline->knots[knot_index];
          double alpha;
          if (fabs (denominator) <= CURVE_EPSILON)
            alpha = 0.0;
          else
            {
              alpha
                  = (parameter - spline->knots[knot_index])
                    / denominator;
              if (alpha < 0.0)
                alpha = 0.0;
              else if (alpha > 1.0)
                alpha = 1.0;
            }
          for (axis = 0; axis < 3; axis++)
            points[index][axis]
                = points[index - 1u][axis] * (1.0 - alpha)
                  + points[index][axis] * alpha;
          weights[index]
              = weights[index - 1u] * (1.0 - alpha)
                + weights[index] * alpha;
        }
    }
  if (!isfinite (weights[sampling->degree])
      || fabs (weights[sampling->degree]) <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3; axis++)
    point[axis]
        = points[sampling->degree][axis]
          / weights[sampling->degree];
  return 1;
}

static int
spline_fallback_point (const Dwg_Entity_SPLINE *spline,
                       int use_fit_points, size_t index,
                       double point[3])
{
  if (!spline || !point)
    return 0;
  if (use_fit_points)
    {
      size_t count = spline_fit_point_count (spline);
      if (index >= count)
        return 0;
      point[0] = spline->fit_pts[index].x;
      point[1] = spline->fit_pts[index].y;
      point[2] = spline->fit_pts[index].z;
    }
  else
    {
      size_t count = spline_control_point_count (spline);
      if (index >= count)
        return 0;
      point[0] = spline->ctrl_pts[index].x;
      point[1] = spline->ctrl_pts[index].y;
      point[2] = spline->ctrl_pts[index].z;
    }
  return 1;
}

static unsigned
spline_fallback_segment_count (const Dwg_Entity_SPLINE *spline)
{
  size_t fit_count = spline_fit_point_count (spline);
  size_t point_count
      = fit_count >= 2u ? fit_count
                        : spline_control_point_count (spline);
  size_t source_segments;
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (spline_is_closed (spline) ? 1u : 0u);
  return source_segments > MAX_SPLINE_SEGMENTS
             ? MAX_SPLINE_SEGMENTS
             : (unsigned)source_segments;
}

static int
spline_fallback_segment (const Dwg_Entity_SPLINE *spline,
                         unsigned segment_index, double start[3],
                         double end[3])
{
  size_t fit_count = spline_fit_point_count (spline);
  int use_fit_points = fit_count >= 2u;
  size_t point_count
      = use_fit_points ? fit_count
                       : spline_control_point_count (spline);
  size_t source_segments;
  unsigned output_segments;
  size_t start_index;
  size_t end_index;
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (spline_is_closed (spline) ? 1u : 0u);
  output_segments
      = source_segments > MAX_SPLINE_SEGMENTS
            ? MAX_SPLINE_SEGMENTS
            : (unsigned)source_segments;
  if (!output_segments || segment_index >= output_segments)
    return 0;
  start_index
      = (size_t)((uint64_t)segment_index * source_segments
                 / output_segments);
  end_index
      = (size_t)((uint64_t)(segment_index + 1u) * source_segments
                 / output_segments);
  start_index %= point_count;
  end_index %= point_count;
  return spline_fallback_point (
             spline, use_fit_points, start_index, start)
         && spline_fallback_point (
             spline, use_fit_points, end_index, end);
}

static int
iterate_spline_segments (const Dwg_Object *object,
                         const CacheTables *tables,
                         SegmentIteration *iteration)
{
  const Dwg_Entity_SPLINE *spline;
  SplineSampling sampling;
  LineSegment base;
  unsigned index;
  if (!object || object->fixedtype != DWG_TYPE_SPLINE
      || !object->tio.entity
      || !(spline = object->tio.entity->tio.SPLINE))
    return 1;
  if (!initialize_entity_segment (object, tables, 7, 1, &base))
    return 1;
  memset (&sampling, 0, sizeof (sampling));
  if (read_spline_sampling (spline, &sampling))
    {
      base.approximated_curve = sampling.degree > 1u ? 1u : 0u;
      for (index = 0; index < sampling.segment_count; index++)
        {
          LineSegment segment = base;
          double start_parameter;
          double end_parameter;
          if (!spline_segment_parameters (
                  spline, &sampling, index, &start_parameter,
                  &end_parameter)
              || !evaluate_spline (
                  spline, &sampling, start_parameter, segment.start)
              || !evaluate_spline (
                  spline, &sampling, end_parameter, segment.end))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          if (!segment_iteration_emit (iteration, &segment))
            return 0;
        }
      return 1;
    }
  {
    unsigned output_segments
        = spline_fallback_segment_count (spline);
    for (index = 0; index < output_segments; index++)
      {
        LineSegment segment = base;
        if (!spline_fallback_segment (
                spline, index, segment.start, segment.end))
          {
            segment_iteration_reject (iteration);
            continue;
          }
        if (!segment_iteration_emit (iteration, &segment))
          return 0;
      }
  }
  return 1;
}

typedef enum
{
  ACIS_RECORD_OTHER = 0,
  ACIS_RECORD_BODY,
  ACIS_RECORD_LUMP,
  ACIS_RECORD_SHELL,
  ACIS_RECORD_FACE,
  ACIS_RECORD_LOOP,
  ACIS_RECORD_COEDGE,
  ACIS_RECORD_EDGE,
  ACIS_RECORD_VERTEX,
  ACIS_RECORD_POINT,
  ACIS_RECORD_STRAIGHT_CURVE,
  ACIS_RECORD_ELLIPSE_CURVE,
  ACIS_RECORD_INTCURVE_CURVE,
  ACIS_RECORD_TRANSFORM
} AcisRecordKind;

typedef enum
{
  ACIS_TOKEN_NUMBER = 0,
  ACIS_TOKEN_POINTER,
  ACIS_TOKEN_IDENTIFIER,
  ACIS_TOKEN_FALSE,
  ACIS_TOKEN_TRUE
} AcisTokenKind;

typedef struct
{
  AcisTokenKind kind;
  int64_t pointer;
  double number;
  const unsigned char *text;
  size_t text_length;
} AcisToken;

typedef struct
{
  int32_t index;
  AcisRecordKind kind;
  size_t first_token;
  size_t token_count;
} AcisRecord;

typedef struct
{
  AcisRecord *records;
  AcisToken *tokens;
  size_t record_count;
  size_t record_capacity;
  size_t token_count;
  size_t token_capacity;
  uint32_t version;
} AcisDocument;

typedef struct
{
  const unsigned char *data;
  size_t size;
  size_t position;
  int join_lines;
} AcisTextReader;

typedef struct
{
  const unsigned char *data;
  size_t length;
} AcisTextSlice;

typedef struct
{
  double matrix[9];
  double translation[3];
  double scale;
} AcisTransform;

typedef struct
{
  size_t degree;
  size_t control_count;
  size_t knot_count;
  double *knots;
  double *controls;
  double *weights;
  int rational;
} AcisSpline;

static void
free_acis_document (AcisDocument *document)
{
  if (!document)
    return;
  free (document->records);
  free (document->tokens);
  memset (document, 0, sizeof (*document));
}

static int
reserve_acis_records (AcisDocument *document, size_t additional)
{
  size_t required;
  size_t capacity;
  AcisRecord *records;
  if (!document || additional > MAX_ACIS_RECORDS_PER_ENTITY
      || document->record_count
             > MAX_ACIS_RECORDS_PER_ENTITY - additional)
    return 0;
  required = document->record_count + additional;
  if (required <= document->record_capacity)
    return 1;
  capacity = document->record_capacity ? document->record_capacity : 256u;
  while (capacity < required)
    {
      if (capacity > MAX_ACIS_RECORDS_PER_ENTITY / 2u)
        {
          capacity = MAX_ACIS_RECORDS_PER_ENTITY;
          break;
        }
      capacity *= 2u;
    }
  if (capacity < required
      || capacity > SIZE_MAX / sizeof (AcisRecord))
    return 0;
  records = (AcisRecord *)realloc (
      document->records, capacity * sizeof (AcisRecord));
  if (!records)
    return 0;
  document->records = records;
  document->record_capacity = capacity;
  return 1;
}

static int
reserve_acis_tokens (AcisDocument *document, size_t additional)
{
  size_t required;
  size_t capacity;
  AcisToken *tokens;
  if (!document || additional > MAX_ACIS_TOKENS_PER_ENTITY
      || document->token_count
             > MAX_ACIS_TOKENS_PER_ENTITY - additional)
    return 0;
  required = document->token_count + additional;
  if (required <= document->token_capacity)
    return 1;
  capacity = document->token_capacity ? document->token_capacity : 1024u;
  while (capacity < required)
    {
      if (capacity > MAX_ACIS_TOKENS_PER_ENTITY / 2u)
        {
          capacity = MAX_ACIS_TOKENS_PER_ENTITY;
          break;
        }
      capacity *= 2u;
    }
  if (capacity < required
      || capacity > SIZE_MAX / sizeof (AcisToken))
    return 0;
  tokens = (AcisToken *)realloc (
      document->tokens, capacity * sizeof (AcisToken));
  if (!tokens)
    return 0;
  document->tokens = tokens;
  document->token_capacity = capacity;
  return 1;
}

static int
append_acis_token (AcisDocument *document, AcisToken token)
{
  if (!reserve_acis_tokens (document, 1u))
    return 0;
  document->tokens[document->token_count++] = token;
  return 1;
}

static int
append_acis_number (AcisDocument *document, double number)
{
  AcisToken token;
  memset (&token, 0, sizeof (token));
  token.kind = ACIS_TOKEN_NUMBER;
  token.number = number;
  return append_acis_token (document, token);
}

static int
append_acis_pointer (AcisDocument *document, int64_t pointer)
{
  AcisToken token;
  memset (&token, 0, sizeof (token));
  token.kind = ACIS_TOKEN_POINTER;
  token.pointer = pointer;
  return append_acis_token (document, token);
}

static int
append_acis_identifier (AcisDocument *document,
                        const unsigned char *text, size_t length)
{
  AcisToken token;
  memset (&token, 0, sizeof (token));
  token.kind = ACIS_TOKEN_IDENTIFIER;
  token.text = text;
  token.text_length = length;
  return append_acis_token (document, token);
}

static int
append_acis_boolean (AcisDocument *document, int value)
{
  AcisToken token;
  memset (&token, 0, sizeof (token));
  token.kind = value ? ACIS_TOKEN_TRUE : ACIS_TOKEN_FALSE;
  return append_acis_token (document, token);
}

static size_t
normalized_acis_text_length (const unsigned char *text, size_t length)
{
  size_t index;
  size_t count = 0;
  for (index = 0; index < length; index++)
    if (text[index] != '\r' && text[index] != '\n')
      count++;
  return count;
}

static int
acis_text_equals (const unsigned char *text, size_t length,
                  const char *expected)
{
  size_t source = 0;
  size_t target = 0;
  size_t expected_length = strlen (expected);
  if (normalized_acis_text_length (text, length) != expected_length)
    return 0;
  while (source < length)
    {
      unsigned char value = text[source++];
      if (value == '\r' || value == '\n')
        continue;
      if (target >= expected_length
          || value != (unsigned char)expected[target++])
        return 0;
    }
  return target == expected_length;
}

static int
copy_normalized_acis_text (const unsigned char *text, size_t length,
                           char *buffer, size_t buffer_size)
{
  size_t source;
  size_t target = 0;
  if (!buffer || !buffer_size)
    return 0;
  for (source = 0; source < length; source++)
    {
      unsigned char value = text[source];
      if (value == '\r' || value == '\n')
        continue;
      if (target + 1u >= buffer_size)
        return 0;
      buffer[target++] = (char)value;
    }
  buffer[target] = '\0';
  return 1;
}

static int
parse_acis_integer_text (const unsigned char *text, size_t length,
                         int64_t *result)
{
  char buffer[96];
  char *end;
  long long value;
  if (!result
      || !copy_normalized_acis_text (
          text, length, buffer, sizeof (buffer)))
    return 0;
  errno = 0;
  value = strtoll (buffer, &end, 10);
  if (errno || end == buffer || *end != '\0')
    return 0;
  *result = (int64_t)value;
  return 1;
}

static int
parse_acis_number_text (const unsigned char *text, size_t length,
                        double *result)
{
  char buffer[128];
  char *end;
  double value;
  if (!result
      || !copy_normalized_acis_text (
          text, length, buffer, sizeof (buffer)))
    return 0;
  errno = 0;
  value = strtod (buffer, &end);
  if (errno || end == buffer || *end != '\0')
    return 0;
  *result = value;
  return 1;
}

static void
skip_acis_text_separators (AcisTextReader *reader)
{
  while (reader && reader->position < reader->size)
    {
      unsigned char value = reader->data[reader->position];
      if (value == ' ' || value == '\t'
          || value == '\r' || value == '\n')
        reader->position++;
      else
        break;
    }
}

static int
next_acis_text_slice (AcisTextReader *reader, AcisTextSlice *slice)
{
  size_t start;
  if (!reader || !slice)
    return 0;
  skip_acis_text_separators (reader);
  if (reader->position >= reader->size)
    return 0;
  if (reader->data[reader->position] == '#')
    {
      slice->data = &reader->data[reader->position++];
      slice->length = 1u;
      return 1;
    }
  start = reader->position;
  while (reader->position < reader->size)
    {
      unsigned char value = reader->data[reader->position];
      if (value == ' ' || value == '\t' || value == '#')
        break;
      if (!reader->join_lines && (value == '\r' || value == '\n'))
        break;
      reader->position++;
    }
  if (reader->position == start)
    return 0;
  slice->data = &reader->data[start];
  slice->length = reader->position - start;
  return 1;
}

static AcisRecordKind
classify_acis_record (const unsigned char *text, size_t length)
{
  if (acis_text_equals (text, length, "body"))
    return ACIS_RECORD_BODY;
  if (acis_text_equals (text, length, "lump"))
    return ACIS_RECORD_LUMP;
  if (acis_text_equals (text, length, "shell"))
    return ACIS_RECORD_SHELL;
  if (acis_text_equals (text, length, "face"))
    return ACIS_RECORD_FACE;
  if (acis_text_equals (text, length, "loop"))
    return ACIS_RECORD_LOOP;
  if (acis_text_equals (text, length, "coedge"))
    return ACIS_RECORD_COEDGE;
  if (acis_text_equals (text, length, "edge"))
    return ACIS_RECORD_EDGE;
  if (acis_text_equals (text, length, "vertex"))
    return ACIS_RECORD_VERTEX;
  if (acis_text_equals (text, length, "point"))
    return ACIS_RECORD_POINT;
  if (acis_text_equals (text, length, "straight-curve"))
    return ACIS_RECORD_STRAIGHT_CURVE;
  if (acis_text_equals (text, length, "ellipse-curve"))
    return ACIS_RECORD_ELLIPSE_CURVE;
  if (acis_text_equals (text, length, "intcurve-curve"))
    return ACIS_RECORD_INTCURVE_CURVE;
  if (acis_text_equals (text, length, "transform"))
    return ACIS_RECORD_TRANSFORM;
  return ACIS_RECORD_OTHER;
}

static int
append_acis_text_slice_token (AcisDocument *document,
                              const AcisTextSlice *slice)
{
  int64_t integer;
  double number;
  if (!document || !slice || !slice->length)
    return 0;
  if (slice->data[0] == '$'
      && parse_acis_integer_text (
          slice->data + 1u, slice->length - 1u, &integer))
    return append_acis_pointer (document, integer);
  if (parse_acis_number_text (slice->data, slice->length, &number))
    return append_acis_number (document, number);
  if (acis_text_equals (slice->data, slice->length, "TRUE")
      || acis_text_equals (slice->data, slice->length, "T"))
    return append_acis_boolean (document, 1);
  if (acis_text_equals (slice->data, slice->length, "FALSE"))
    return append_acis_boolean (document, 0);
  return append_acis_identifier (
      document, slice->data, slice->length);
}

static int
append_acis_embedded_text (AcisDocument *document,
                           const unsigned char *text, size_t length)
{
  AcisTextReader reader;
  AcisTextSlice slice;
  memset (&reader, 0, sizeof (reader));
  reader.data = text;
  reader.size = length;
  while (next_acis_text_slice (&reader, &slice))
    if (!append_acis_text_slice_token (document, &slice))
      return 0;
  return 1;
}

static int
begin_acis_record (AcisDocument *document, int32_t index,
                   AcisRecordKind kind, AcisRecord **record)
{
  AcisRecord *created;
  if (!document || !record
      || !reserve_acis_records (document, 1u))
    return 0;
  created = &document->records[document->record_count++];
  memset (created, 0, sizeof (*created));
  created->index = index;
  created->kind = kind;
  created->first_token = document->token_count;
  *record = created;
  return 1;
}

static int
parse_sat_acis_document (const unsigned char *data, size_t size,
                         AcisDocument *document)
{
  AcisTextReader reader;
  AcisTextSlice slice;
  size_t header_end = 0;
  size_t line_count = 0;
  size_t index;
  int64_t version;
  int32_t automatic_index = 0;
  if (!data || !document || !size
      || size > MAX_ACIS_BYTES_PER_ENTITY)
    return 0;
  for (index = 0; index < size && line_count < 3u; index++)
    if (data[index] == '\n')
      {
        line_count++;
        header_end = index + 1u;
      }
  if (line_count < 3u)
    return 0;
  memset (&reader, 0, sizeof (reader));
  reader.data = data;
  reader.size = header_end;
  if (!next_acis_text_slice (&reader, &slice)
      || !parse_acis_integer_text (
          slice.data, slice.length, &version)
      || version < 1 || version > UINT32_MAX)
    return 0;
  document->version = (uint32_t)version;
  memset (&reader, 0, sizeof (reader));
  reader.data = data;
  reader.size = size;
  reader.position = header_end;
  reader.join_lines = 1;
  while (next_acis_text_slice (&reader, &slice))
    {
      AcisTextSlice type_slice = slice;
      AcisRecordKind kind;
      AcisRecord *record;
      int32_t record_index = automatic_index;
      int64_t explicit_index;
      AcisTextSlice attribute;
      size_t first_token;
      if (slice.length == 1u && slice.data[0] == '#')
        continue;
      if (document->version >= 700u && slice.length > 1u
          && slice.data[0] == '-'
          && parse_acis_integer_text (
              slice.data, slice.length, &explicit_index)
          && explicit_index <= 0
          && explicit_index >= INT32_MIN)
        {
          int64_t positive
              = explicit_index == INT32_MIN
                    ? (int64_t)INT32_MAX + 1u
                    : -explicit_index;
          if (positive > INT32_MAX
              || !next_acis_text_slice (&reader, &type_slice))
            return 0;
          record_index = (int32_t)positive;
        }
      if (acis_text_equals (
              type_slice.data, type_slice.length,
              "End-of-ACIS-data")
          || acis_text_equals (
              type_slice.data, type_slice.length,
              "End-of-ASM-data"))
        break;
      kind = classify_acis_record (
          type_slice.data, type_slice.length);
      if (!begin_acis_record (
              document, record_index, kind, &record)
          || !next_acis_text_slice (&reader, &attribute))
        return 0;
      first_token = document->token_count;
      if (document->version >= 700u)
        {
          AcisTextReader saved = reader;
          AcisTextSlice subtype;
          int64_t subtype_id;
          if (next_acis_text_slice (&reader, &subtype)
              && !parse_acis_integer_text (
                  subtype.data, subtype.length, &subtype_id))
            reader = saved;
        }
      for (;;)
        {
          if (!next_acis_text_slice (&reader, &slice))
            return 0;
          if (slice.length == 1u && slice.data[0] == '#')
            break;
          if (!append_acis_text_slice_token (document, &slice))
            return 0;
        }
      record->first_token = first_token;
      record->token_count = document->token_count - first_token;
      if (record_index >= automatic_index)
        automatic_index = record_index + 1;
      else
        automatic_index++;
    }
  return document->record_count != 0u;
}

static int
read_acis_u8 (const unsigned char *data, size_t size,
              size_t *position, uint8_t *value)
{
  if (!data || !position || !value || *position >= size)
    return 0;
  *value = data[(*position)++];
  return 1;
}

static int
read_acis_u16 (const unsigned char *data, size_t size,
               size_t *position, uint16_t *value)
{
  if (!data || !position || !value || *position > size
      || size - *position < 2u)
    return 0;
  *value = (uint16_t)data[*position]
           | (uint16_t)((uint16_t)data[*position + 1u] << 8u);
  *position += 2u;
  return 1;
}

static int
read_acis_u32 (const unsigned char *data, size_t size,
               size_t *position, uint32_t *value)
{
  if (!data || !position || !value || *position > size
      || size - *position < 4u)
    return 0;
  *value = (uint32_t)data[*position]
           | (uint32_t)data[*position + 1u] << 8u
           | (uint32_t)data[*position + 2u] << 16u
           | (uint32_t)data[*position + 3u] << 24u;
  *position += 4u;
  return 1;
}

static int
read_acis_u64 (const unsigned char *data, size_t size,
               size_t *position, uint64_t *value)
{
  uint32_t low;
  uint32_t high;
  if (!read_acis_u32 (data, size, position, &low)
      || !read_acis_u32 (data, size, position, &high))
    return 0;
  *value = (uint64_t)low | (uint64_t)high << 32u;
  return 1;
}

static int
read_acis_f32 (const unsigned char *data, size_t size,
               size_t *position, double *value)
{
  uint32_t bits;
  float decoded;
  if (!value || !read_acis_u32 (data, size, position, &bits))
    return 0;
  memcpy (&decoded, &bits, sizeof (decoded));
  *value = (double)decoded;
  return 1;
}

static int
read_acis_f64 (const unsigned char *data, size_t size,
               size_t *position, double *value)
{
  uint64_t bits;
  if (!value || !read_acis_u64 (data, size, position, &bits))
    return 0;
  memcpy (value, &bits, sizeof (*value));
  return 1;
}

static int
read_sab_string (const unsigned char *data, size_t size,
                 size_t *position, size_t length_bytes,
                 const unsigned char **text, size_t *length)
{
  uint8_t length8;
  uint16_t length16;
  uint32_t length32;
  size_t decoded;
  if (!data || !position || !text || !length)
    return 0;
  if (length_bytes == 1u)
    {
      if (!read_acis_u8 (data, size, position, &length8))
        return 0;
      decoded = (size_t)length8;
    }
  else if (length_bytes == 2u)
    {
      if (!read_acis_u16 (data, size, position, &length16))
        return 0;
      decoded = (size_t)length16;
    }
  else if (length_bytes == 4u)
    {
      if (!read_acis_u32 (data, size, position, &length32))
        return 0;
      decoded = (size_t)length32;
    }
  else
    return 0;
  if (*position > size || decoded > size - *position)
    return 0;
  *text = &data[*position];
  *length = decoded;
  *position += decoded;
  return 1;
}

static int
read_tagged_sab_string (const unsigned char *data, size_t size,
                        size_t *position)
{
  uint8_t tag;
  const unsigned char *text;
  size_t length;
  if (!read_acis_u8 (data, size, position, &tag))
    return 0;
  if (tag == 0x07u)
    return read_sab_string (
        data, size, position, 1u, &text, &length);
  if (tag == 0x08u)
    return read_sab_string (
        data, size, position, 2u, &text, &length);
  if (tag == 0x09u || tag == 0x12u)
    return read_sab_string (
        data, size, position, 4u, &text, &length);
  return 0;
}

static int
read_tagged_sab_double (const unsigned char *data, size_t size,
                        size_t *position, double *value)
{
  uint8_t tag;
  return read_acis_u8 (data, size, position, &tag)
         && tag == 0x06u
         && read_acis_f64 (data, size, position, value);
}

static int
append_sab_record_token (AcisDocument *document,
                         const unsigned char *data, size_t size,
                         size_t *position, uint8_t tag)
{
  const unsigned char *text;
  size_t length;
  uint8_t value8;
  uint16_t value16;
  uint32_t value32;
  uint64_t value64;
  double number;
  size_t axis;
  switch (tag)
    {
    case 0x02u:
      return read_acis_u8 (data, size, position, &value8)
             && append_acis_number (
                 document, (double)(int8_t)value8);
    case 0x03u:
      return read_acis_u16 (data, size, position, &value16)
             && append_acis_number (
                 document, (double)(int16_t)value16);
    case 0x04u:
    case 0x15u:
      return read_acis_u32 (data, size, position, &value32)
             && append_acis_number (
                 document, (double)(int32_t)value32);
    case 0x05u:
      return read_acis_f32 (data, size, position, &number)
             && append_acis_number (document, number);
    case 0x06u:
      return read_acis_f64 (data, size, position, &number)
             && append_acis_number (document, number);
    case 0x07u:
      return read_sab_string (
                 data, size, position, 1u, &text, &length)
             && append_acis_identifier (document, text, length);
    case 0x08u:
      return read_sab_string (
                 data, size, position, 2u, &text, &length)
             && append_acis_identifier (document, text, length);
    case 0x09u:
      return read_sab_string (
                 data, size, position, 4u, &text, &length)
             && append_acis_identifier (document, text, length);
    case 0x0au:
      return append_acis_boolean (document, 0);
    case 0x0bu:
      return append_acis_boolean (document, 1);
    case 0x0cu:
      return read_acis_u32 (data, size, position, &value32)
             && append_acis_pointer (
                 document, (int64_t)(int32_t)value32);
    case 0x0du:
    case 0x0eu:
      return read_sab_string (
                 data, size, position, 1u, &text, &length)
             && append_acis_identifier (document, text, length);
    case 0x0fu:
      return append_acis_identifier (
          document, (const unsigned char *)"{", 1u);
    case 0x10u:
      return append_acis_identifier (
          document, (const unsigned char *)"}", 1u);
    case 0x12u:
      return read_sab_string (
                 data, size, position, 4u, &text, &length)
             && append_acis_embedded_text (
                 document, text, length);
    case 0x13u:
    case 0x14u:
      for (axis = 0; axis < 3u; axis++)
        if (!read_acis_f64 (
                data, size, position, &number)
            || !append_acis_number (document, number))
          return 0;
      return 1;
    case 0x17u:
      return read_acis_u64 (data, size, position, &value64)
             && append_acis_number (
                 document, (double)(int64_t)value64);
    default:
      return 0;
    }
}

static int
append_sab_name_part (char *name, size_t name_size,
                      size_t *name_length,
                      const unsigned char *text, size_t length)
{
  if (!name || !name_size || !name_length
      || length > name_size - *name_length - 1u)
    return 0;
  if (*name_length)
    name[(*name_length)++] = '-';
  memcpy (&name[*name_length], text, length);
  *name_length += length;
  name[*name_length] = '\0';
  return 1;
}

static int
parse_sab_acis_document (const unsigned char *data, size_t size,
                         AcisDocument *document)
{
  size_t position = 15u;
  uint32_t version;
  uint32_t ignored;
  double tolerance;
  int32_t record_index = 0;
  if (!data || !document || size < 31u
      || size > MAX_ACIS_BYTES_PER_ENTITY
      || (memcmp (data, "ACIS BinaryFile", 15u) != 0
          && memcmp (data, "ASM BinaryFile", 14u) != 0)
      || !read_acis_u32 (data, size, &position, &version)
      || !read_acis_u32 (data, size, &position, &ignored)
      || !read_acis_u32 (data, size, &position, &ignored)
      || !read_acis_u32 (data, size, &position, &ignored)
      || !read_tagged_sab_string (data, size, &position)
      || !read_tagged_sab_string (data, size, &position)
      || !read_tagged_sab_string (data, size, &position)
      || !read_tagged_sab_double (
          data, size, &position, &tolerance)
      || !read_tagged_sab_double (
          data, size, &position, &tolerance))
    return 0;
  if (position < size && data[position] == 0x06u
      && !read_tagged_sab_double (
          data, size, &position, &tolerance))
    return 0;
  document->version = version;
  while (position < size)
    {
      char name[128];
      size_t name_length = 0;
      const unsigned char *part;
      size_t part_length;
      uint8_t tag;
      AcisRecord *record;
      AcisRecordKind kind;
      size_t first_token;
      uint32_t ignored_value;
      memset (name, 0, sizeof (name));
      while (position < size && data[position] == 0x0eu)
        {
          position++;
          if (!read_sab_string (
                  data, size, &position, 1u, &part, &part_length)
              || !append_sab_name_part (
                  name, sizeof (name), &name_length,
                  part, part_length))
            return 0;
        }
      if (position >= size || data[position++] != 0x0du
          || !read_sab_string (
              data, size, &position, 1u, &part, &part_length)
          || !append_sab_name_part (
              name, sizeof (name), &name_length,
              part, part_length))
        return 0;
      if (strcmp (name, "End-of-ACIS-data") == 0
          || strcmp (name, "End-of-ASM-data") == 0)
        break;
      kind = classify_acis_record (
          (const unsigned char *)name, name_length);
      if (!begin_acis_record (
              document, record_index++, kind, &record))
        return 0;
      if (position < size && data[position] == 0x0cu)
        {
          position++;
          if (!read_acis_u32 (
                  data, size, &position, &ignored_value))
            return 0;
        }
      if (position < size && data[position] == 0x04u)
        {
          position++;
          if (!read_acis_u32 (
                  data, size, &position, &ignored_value))
            return 0;
        }
      first_token = document->token_count;
      for (;;)
        {
          if (!read_acis_u8 (data, size, &position, &tag))
            return 0;
          if (tag == 0x11u)
            break;
          if (!append_sab_record_token (
                  document, data, size, &position, tag))
            return 0;
        }
      record->first_token = first_token;
      record->token_count = document->token_count - first_token;
    }
  return document->record_count != 0u;
}

static int
read_acis_entity_data (const Dwg_Object *object,
                       const unsigned char **data, size_t *size,
                       int *binary)
{
  const Dwg_Entity__3DSOLID *solid = NULL;
  uint64_t total = 0;
  size_t block;
  if (!object || !object->tio.entity || !data || !size || !binary)
    return 0;
  if (object->fixedtype == DWG_TYPE_REGION)
    solid = object->tio.entity->tio.REGION;
  else if (object->fixedtype == DWG_TYPE__3DSOLID)
    solid = object->tio.entity->tio._3DSOLID;
  else if (object->fixedtype == DWG_TYPE_BODY)
    solid = object->tio.entity->tio.BODY;
  if (!solid || !solid->acis_data || solid->acis_empty)
    return 0;
  if (solid->version > 1)
    {
      total = (uint64_t)solid->sab_size;
      *binary = 1;
    }
  else
    {
      if (!solid->block_size
          || solid->num_blocks > MAX_ACIS_RECORDS_PER_ENTITY)
        return 0;
      for (block = 0; block < (size_t)solid->num_blocks; block++)
        {
          uint64_t length = (uint64_t)solid->block_size[block];
          if (length > MAX_ACIS_BYTES_PER_ENTITY - total)
            return 0;
          total += length;
        }
      *binary = 0;
    }
  if (!total || total > MAX_ACIS_BYTES_PER_ENTITY
      || total > SIZE_MAX)
    return 0;
  *data = (const unsigned char *)solid->acis_data;
  *size = (size_t)total;
  return 1;
}

static int
parse_acis_entity_document (const Dwg_Object *object,
                            AcisDocument *document)
{
  const unsigned char *data;
  size_t size;
  int binary;
  int success;
  if (!document)
    return 0;
  memset (document, 0, sizeof (*document));
  if (!read_acis_entity_data (
          object, &data, &size, &binary))
    return 0;
  success = binary
                ? parse_sab_acis_document (data, size, document)
                : parse_sat_acis_document (data, size, document);
  if (!success)
    free_acis_document (document);
  return success;
}

static const AcisRecord *
find_acis_record (const AcisDocument *document, int64_t index)
{
  size_t low;
  size_t high;
  if (!document || index < 0 || index > INT32_MAX)
    return NULL;
  if ((uint64_t)index < (uint64_t)document->record_count
      && document->records[index].index == (int32_t)index)
    return &document->records[index];
  low = 0;
  high = document->record_count;
  while (low < high)
    {
      size_t middle = low + (high - low) / 2u;
      int32_t candidate = document->records[middle].index;
      if ((int64_t)candidate < index)
        low = middle + 1u;
      else
        high = middle;
    }
  if (low < document->record_count
      && document->records[low].index == (int32_t)index)
    return &document->records[low];
  return NULL;
}

static const AcisToken *
acis_record_token (const AcisDocument *document,
                   const AcisRecord *record, size_t index)
{
  if (!document || !record || index >= record->token_count
      || record->first_token > document->token_count
      || index > document->token_count - record->first_token)
    return NULL;
  return &document->tokens[record->first_token + index];
}

static int
acis_record_pointer_from_end (const AcisDocument *document,
                              const AcisRecord *record,
                              size_t reverse_ordinal,
                              int64_t *pointer)
{
  size_t index;
  size_t ordinal = 0;
  if (!document || !record || !pointer)
    return 0;
  for (index = record->token_count; index > 0; index--)
    {
      const AcisToken *token
          = acis_record_token (document, record, index - 1u);
      if (!token || token->kind != ACIS_TOKEN_POINTER)
        continue;
      if (ordinal++ == reverse_ordinal)
        {
          *pointer = token->pointer;
          return 1;
        }
    }
  return 0;
}

static int
acis_record_number (const AcisDocument *document,
                    const AcisRecord *record, size_t ordinal,
                    double *number)
{
  size_t index;
  size_t current = 0;
  if (!document || !record || !number)
    return 0;
  for (index = 0; index < record->token_count; index++)
    {
      const AcisToken *token
          = acis_record_token (document, record, index);
      if (!token || token->kind != ACIS_TOKEN_NUMBER)
        continue;
      if (current++ == ordinal)
        {
          *number = token->number;
          return 1;
        }
    }
  return 0;
}

static int
acis_token_identifier_equals (const AcisToken *token,
                              const char *expected)
{
  return token && token->kind == ACIS_TOKEN_IDENTIFIER
         && acis_text_equals (
             token->text, token->text_length, expected);
}

static int
acis_record_is_reversed (const AcisDocument *document,
                         const AcisRecord *record)
{
  size_t index;
  if (!document || !record)
    return 0;
  for (index = record->token_count; index > 0; index--)
    {
      const AcisToken *token
          = acis_record_token (document, record, index - 1u);
      if (!token)
        continue;
      if (token->kind == ACIS_TOKEN_FALSE
          || acis_token_identifier_equals (token, "reversed"))
        return 1;
      if (token->kind == ACIS_TOKEN_TRUE
          || acis_token_identifier_equals (token, "forward"))
        return 0;
    }
  return 0;
}

static int
acis_point_from_record (const AcisDocument *document,
                        const AcisRecord *record, double point[3])
{
  size_t axis;
  if (!record || record->kind != ACIS_RECORD_POINT || !point)
    return 0;
  for (axis = 0; axis < 3u; axis++)
    if (!acis_record_number (document, record, axis, &point[axis])
        || !isfinite (point[axis]))
      return 0;
  return 1;
}

static int
acis_edge_endpoint (const AcisDocument *document,
                    const AcisRecord *edge, int end,
                    double point[3])
{
  int64_t vertex_pointer;
  int64_t point_pointer;
  const AcisRecord *vertex;
  const AcisRecord *point_record;
  size_t reverse_ordinal = end ? 2u : 3u;
  if (!edge || edge->kind != ACIS_RECORD_EDGE
      || !acis_record_pointer_from_end (
          document, edge, reverse_ordinal, &vertex_pointer)
      || !(vertex = find_acis_record (document, vertex_pointer))
      || vertex->kind != ACIS_RECORD_VERTEX
      || !acis_record_pointer_from_end (
          document, vertex, 0u, &point_pointer)
      || !(point_record = find_acis_record (
          document, point_pointer)))
    return 0;
  return acis_point_from_record (document, point_record, point);
}

static void
identity_acis_transform (AcisTransform *transform)
{
  if (!transform)
    return;
  memset (transform, 0, sizeof (*transform));
  transform->matrix[0] = 1.0;
  transform->matrix[4] = 1.0;
  transform->matrix[8] = 1.0;
  transform->scale = 1.0;
}

static int
acis_transform_from_record (const AcisDocument *document,
                            const AcisRecord *record,
                            AcisTransform *transform)
{
  size_t index;
  identity_acis_transform (transform);
  if (!record || record->kind != ACIS_RECORD_TRANSFORM)
    return 0;
  for (index = 0; index < 9u; index++)
    if (!acis_record_number (
            document, record, index, &transform->matrix[index])
        || !isfinite (transform->matrix[index]))
      return 0;
  for (index = 0; index < 3u; index++)
    if (!acis_record_number (
            document, record, 9u + index,
            &transform->translation[index])
        || !isfinite (transform->translation[index]))
      return 0;
  if (!acis_record_number (
          document, record, 12u, &transform->scale)
      || !isfinite (transform->scale)
      || fabs (transform->scale) <= CURVE_EPSILON)
    return 0;
  return 1;
}

static const AcisRecord *
acis_edge_body (const AcisDocument *document,
                const AcisRecord *edge)
{
  const AcisRecord *record;
  int64_t pointer;
  if (!acis_record_pointer_from_end (
          document, edge, 1u, &pointer)
      || !(record = find_acis_record (document, pointer))
      || record->kind != ACIS_RECORD_COEDGE
      || !acis_record_pointer_from_end (
          document, record, 0u, &pointer)
      || !(record = find_acis_record (document, pointer))
      || record->kind != ACIS_RECORD_LOOP
      || !acis_record_pointer_from_end (
          document, record, 0u, &pointer)
      || !(record = find_acis_record (document, pointer))
      || record->kind != ACIS_RECORD_FACE
      || !acis_record_pointer_from_end (
          document, record, 2u, &pointer)
      || !(record = find_acis_record (document, pointer))
      || record->kind != ACIS_RECORD_SHELL
      || !acis_record_pointer_from_end (
          document, record, 0u, &pointer)
      || !(record = find_acis_record (document, pointer))
      || record->kind != ACIS_RECORD_LUMP
      || !acis_record_pointer_from_end (
          document, record, 0u, &pointer)
      || !(record = find_acis_record (document, pointer))
      || record->kind != ACIS_RECORD_BODY)
    return NULL;
  return record;
}

static const AcisRecord *
first_acis_body (const AcisDocument *document)
{
  size_t index;
  if (!document)
    return NULL;
  for (index = 0; index < document->record_count; index++)
    if (document->records[index].kind == ACIS_RECORD_BODY)
      return &document->records[index];
  return NULL;
}

static void
acis_edge_transform (const AcisDocument *document,
                     const AcisRecord *edge,
                     AcisTransform *transform)
{
  const AcisRecord *body = acis_edge_body (document, edge);
  const AcisRecord *transform_record;
  int64_t pointer;
  identity_acis_transform (transform);
  if (!body)
    body = first_acis_body (document);
  if (!body
      || !acis_record_pointer_from_end (
          document, body, 0u, &pointer)
      || pointer < 0
      || !(transform_record = find_acis_record (
          document, pointer)))
    return;
  (void)acis_transform_from_record (
      document, transform_record, transform);
}

static void
apply_acis_transform (const AcisTransform *transform,
                      const double point[3], double result[3])
{
  double scaled[3];
  scaled[0] = point[0] * transform->matrix[0]
              + point[1] * transform->matrix[3]
              + point[2] * transform->matrix[6];
  scaled[1] = point[0] * transform->matrix[1]
              + point[1] * transform->matrix[4]
              + point[2] * transform->matrix[7];
  scaled[2] = point[0] * transform->matrix[2]
              + point[1] * transform->matrix[5]
              + point[2] * transform->matrix[8];
  result[0] = scaled[0] * transform->scale
              + transform->translation[0];
  result[1] = scaled[1] * transform->scale
              + transform->translation[1];
  result[2] = scaled[2] * transform->scale
              + transform->translation[2];
}

static double
acis_ellipse_parameter (const double center[3],
                        const double major_axis[3],
                        const double minor_axis[3],
                        const double point[3])
{
  double difference[3];
  double major_squared = 0.0;
  double minor_squared = 0.0;
  double major_projection = 0.0;
  double minor_projection = 0.0;
  size_t axis;
  for (axis = 0; axis < 3u; axis++)
    {
      difference[axis] = point[axis] - center[axis];
      major_squared += major_axis[axis] * major_axis[axis];
      minor_squared += minor_axis[axis] * minor_axis[axis];
      major_projection += difference[axis] * major_axis[axis];
      minor_projection += difference[axis] * minor_axis[axis];
    }
  if (!isfinite (major_squared) || !isfinite (minor_squared)
      || major_squared <= CURVE_EPSILON
      || minor_squared <= CURVE_EPSILON)
    return NAN;
  return atan2 (
      minor_projection / minor_squared,
      major_projection / major_squared);
}

static void
free_acis_spline (AcisSpline *spline)
{
  if (!spline)
    return;
  free (spline->knots);
  free (spline->controls);
  free (spline->weights);
  memset (spline, 0, sizeof (*spline));
}

static int
acis_token_number_at (const AcisDocument *document,
                      const AcisRecord *record, size_t index,
                      double *number)
{
  const AcisToken *token
      = acis_record_token (document, record, index);
  if (!token || token->kind != ACIS_TOKEN_NUMBER || !number)
    return 0;
  *number = token->number;
  return 1;
}

static int
acis_bounded_integer (double value, size_t maximum, size_t *result)
{
  double rounded;
  if (!result || !isfinite (value) || value < 0.0
      || value > (double)maximum)
    return 0;
  rounded = nearbyint (value);
  if (fabs (rounded - value) > 1.0e-7)
    return 0;
  *result = (size_t)rounded;
  return 1;
}

static int
parse_acis_exact_spline (const AcisDocument *document,
                         const AcisRecord *record,
                         AcisSpline *spline)
{
  size_t position;
  size_t degree;
  size_t closure;
  size_t unique_count;
  size_t control_count;
  size_t knot_count;
  size_t index;
  size_t sum = 0;
  size_t expanded = 0;
  double value;
  double *unique_knots = NULL;
  size_t *multiplicities = NULL;
  const AcisToken *token;
  int success = 0;
  if (!document || !record || !spline
      || record->kind != ACIS_RECORD_INTCURVE_CURVE)
    return 0;
  memset (spline, 0, sizeof (*spline));
  for (position = 0; position < record->token_count; position++)
    {
      token = acis_record_token (document, record, position);
      if (acis_token_identifier_equals (token, "exact_int_cur"))
        break;
    }
  if (position >= record->token_count)
    return 0;
  position++;
  if (!acis_token_number_at (
          document, record, position++, &value))
    return 0;
  token = acis_record_token (document, record, position++);
  if (!acis_token_identifier_equals (token, "nurbs")
      && !acis_token_identifier_equals (token, "nubs"))
    return 0;
  spline->rational = acis_token_identifier_equals (token, "nurbs");
  if (!acis_token_number_at (
          document, record, position++, &value)
      || !acis_bounded_integer (
          value, MAX_SPLINE_DEGREE, &degree)
      || degree < 1u
      || !acis_token_number_at (
          document, record, position++, &value)
      || !acis_bounded_integer (value, 2u, &closure)
      || !acis_token_number_at (
          document, record, position++, &value)
      || !acis_bounded_integer (
          value, MAX_ACIS_KNOTS, &unique_count)
      || unique_count < 2u)
    return 0;
  unique_knots = (double *)malloc (
      unique_count * sizeof (double));
  multiplicities = (size_t *)malloc (
      unique_count * sizeof (size_t));
  if (!unique_knots || !multiplicities)
    goto done;
  for (index = 0; index < unique_count; index++)
    {
      if (!acis_token_number_at (
              document, record, position++, &unique_knots[index])
          || !isfinite (unique_knots[index])
          || (index && unique_knots[index - 1u]
                           > unique_knots[index])
          || !acis_token_number_at (
              document, record, position++, &value)
          || !acis_bounded_integer (
              value, MAX_ACIS_CONTROL_POINTS,
              &multiplicities[index])
          || !multiplicities[index]
          || sum > MAX_ACIS_CONTROL_POINTS
                       - multiplicities[index])
        goto done;
      sum += multiplicities[index];
    }
  if (sum <= degree - 1u)
    goto done;
  control_count = sum - (degree - 1u);
  if (control_count <= degree
      || control_count > MAX_ACIS_CONTROL_POINTS)
    goto done;
  multiplicities[0] = degree + 1u;
  multiplicities[unique_count - 1u] = degree + 1u;
  for (index = 0; index < unique_count; index++)
    {
      if (expanded > MAX_ACIS_CONTROL_POINTS
                         + MAX_SPLINE_DEGREE + 1u
                       - multiplicities[index])
        goto done;
      expanded += multiplicities[index];
    }
  knot_count = control_count + degree + 1u;
  if (expanded != knot_count)
    goto done;
  spline->knots = (double *)malloc (
      knot_count * sizeof (double));
  spline->controls = (double *)malloc (
      control_count * 3u * sizeof (double));
  spline->weights = (double *)malloc (
      control_count * sizeof (double));
  if (!spline->knots || !spline->controls || !spline->weights)
    goto done;
  expanded = 0;
  for (index = 0; index < unique_count; index++)
    {
      size_t repeat;
      for (repeat = 0; repeat < multiplicities[index]; repeat++)
        spline->knots[expanded++] = unique_knots[index];
    }
  for (index = 0; index < control_count; index++)
    {
      size_t axis;
      for (axis = 0; axis < 3u; axis++)
        if (!acis_token_number_at (
                document, record, position++,
                &spline->controls[index * 3u + axis])
            || !isfinite (
                spline->controls[index * 3u + axis]))
          goto done;
      spline->weights[index] = 1.0;
      if (spline->rational
          && (!acis_token_number_at (
                  document, record, position++,
                  &spline->weights[index])
              || !isfinite (spline->weights[index])
              || fabs (spline->weights[index]) <= CURVE_EPSILON))
        goto done;
    }
  spline->degree = degree;
  spline->control_count = control_count;
  spline->knot_count = knot_count;
  (void)closure;
  success = 1;

done:
  free (unique_knots);
  free (multiplicities);
  if (!success)
    free_acis_spline (spline);
  return success;
}

static int
evaluate_acis_spline (const AcisSpline *spline, double parameter,
                      double point[3])
{
  double points[MAX_SPLINE_DEGREE + 1u][3];
  double weights[MAX_SPLINE_DEGREE + 1u];
  size_t span = SIZE_MAX;
  size_t index;
  size_t level;
  size_t axis;
  double domain_end;
  if (!spline || !point || !isfinite (parameter)
      || !spline->knots || !spline->controls || !spline->weights
      || spline->degree > MAX_SPLINE_DEGREE
      || spline->control_count <= spline->degree)
    return 0;
  domain_end = spline->knots[spline->control_count];
  if (parameter >= domain_end - CURVE_EPSILON)
    span = spline->control_count - 1u;
  else
    for (index = spline->degree;
         index < spline->control_count; index++)
      if (spline->knots[index] <= parameter
          && parameter < spline->knots[index + 1u])
        {
          span = index;
          break;
        }
  if (span == SIZE_MAX || span < spline->degree)
    return 0;
  for (index = 0; index <= spline->degree; index++)
    {
      size_t control_index = span - spline->degree + index;
      double weight = spline->weights[control_index];
      for (axis = 0; axis < 3u; axis++)
        points[index][axis]
            = spline->controls[control_index * 3u + axis] * weight;
      weights[index] = weight;
    }
  for (level = 1; level <= spline->degree; level++)
    for (index = spline->degree; index >= level; index--)
      {
        size_t knot_index = span - spline->degree + index;
        double denominator
            = spline->knots[knot_index + spline->degree - level + 1u]
              - spline->knots[knot_index];
        double alpha = fabs (denominator) <= CURVE_EPSILON
                           ? 0.0
                           : (parameter - spline->knots[knot_index])
                                 / denominator;
        if (alpha < 0.0)
          alpha = 0.0;
        else if (alpha > 1.0)
          alpha = 1.0;
        for (axis = 0; axis < 3u; axis++)
          points[index][axis]
              = points[index - 1u][axis] * (1.0 - alpha)
                + points[index][axis] * alpha;
        weights[index]
            = weights[index - 1u] * (1.0 - alpha)
              + weights[index] * alpha;
      }
  if (!isfinite (weights[spline->degree])
      || fabs (weights[spline->degree]) <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3u; axis++)
    point[axis] = points[spline->degree][axis]
                  / weights[spline->degree];
  return 1;
}

static unsigned
acis_spline_segment_count (const AcisSpline *spline,
                           double start, double end)
{
  size_t index;
  size_t spans = 0;
  size_t requested;
  if (!spline || !isfinite (start) || !isfinite (end)
      || end - start <= CURVE_EPSILON)
    return 0;
  for (index = spline->degree;
       index < spline->control_count; index++)
    {
      double span_start = fmax (start, spline->knots[index]);
      double span_end = fmin (end, spline->knots[index + 1u]);
      if (span_end - span_start > CURVE_EPSILON)
        spans++;
    }
  if (!spans || spans > SIZE_MAX / HATCH_SPLINE_SEGMENTS_PER_SPAN)
    return 0;
  requested = spans * HATCH_SPLINE_SEGMENTS_PER_SPAN;
  return requested > MAX_HATCH_SPLINE_SEGMENTS
             ? MAX_HATCH_SPLINE_SEGMENTS
             : (unsigned)requested;
}

static int
emit_acis_spline_edge (const AcisDocument *document,
                       const AcisRecord *edge,
                       const AcisRecord *curve,
                       const AcisTransform *transform,
                       const LineSegment *base,
                       SegmentIteration *iteration,
                       uint64_t *generated, int *handled)
{
  AcisSpline spline;
  double domain_start;
  double domain_end;
  double start;
  double end;
  unsigned segment_count;
  unsigned index;
  uint64_t generated_before = *generated;
  *handled = 0;
  if (!parse_acis_exact_spline (document, curve, &spline))
    return 1;
  domain_start = spline.knots[spline.degree];
  domain_end = spline.knots[spline.control_count];
  start = domain_start;
  end = domain_end;
  {
    double edge_start;
    double edge_end;
    if (acis_record_number (document, edge, 0u, &edge_start)
        && acis_record_number (document, edge, 1u, &edge_end)
        && isfinite (edge_start) && isfinite (edge_end))
      {
        start = fmax (domain_start, fmin (edge_start, edge_end));
        end = fmin (domain_end, fmax (edge_start, edge_end));
      }
  }
  segment_count = acis_spline_segment_count (&spline, start, end);
  if (!segment_count)
    {
      free_acis_spline (&spline);
      return 1;
    }
  for (index = 0; index < segment_count; index++)
    {
      double local_start[3];
      double local_end[3];
      double first = start + (end - start) * (double)index
                               / (double)segment_count;
      double last = start + (end - start) * (double)(index + 1u)
                              / (double)segment_count;
      LineSegment segment = *base;
      if (*generated >= MAX_ACIS_SEGMENTS_PER_ENTITY)
        break;
      if (!evaluate_acis_spline (&spline, first, local_start)
          || !evaluate_acis_spline (&spline, last, local_end))
        {
          segment_iteration_reject (iteration);
          continue;
        }
      apply_acis_transform (transform, local_start, segment.start);
      apply_acis_transform (transform, local_end, segment.end);
      segment.source_kind = 7u;
      segment.approximated_curve = 1u;
      if (!segment_iteration_emit (iteration, &segment))
        {
          free_acis_spline (&spline);
          return 0;
        }
      (*generated)++;
    }
  *handled = *generated != generated_before;
  free_acis_spline (&spline);
  return 1;
}

static int
emit_acis_ellipse_edge (const AcisDocument *document,
                        const AcisRecord *edge,
                        const AcisRecord *curve,
                        const AcisTransform *transform,
                        const double edge_start[3],
                        const double edge_end[3],
                        const LineSegment *base,
                        SegmentIteration *iteration,
                        uint64_t *generated, int *handled)
{
  double center[3];
  double normal[3];
  double major_axis[3];
  double minor_axis[3];
  double ratio;
  double start;
  double end;
  double sweep;
  double parameter_start;
  double parameter_end;
  double endpoint_distance_squared = 0.0;
  unsigned segment_count;
  unsigned index;
  int reversed;
  size_t axis;
  *handled = 0;
  for (axis = 0; axis < 3u; axis++)
    {
      if (!acis_record_number (document, curve, axis, &center[axis])
          || !acis_record_number (
              document, curve, 3u + axis, &normal[axis])
          || !acis_record_number (
              document, curve, 6u + axis, &major_axis[axis]))
        return 1;
      endpoint_distance_squared
          += (edge_end[axis] - edge_start[axis])
             * (edge_end[axis] - edge_start[axis]);
    }
  if (!acis_record_number (document, curve, 9u, &ratio)
      || !ellipse_axes (major_axis, normal, ratio, minor_axis))
    return 1;
  reversed = acis_record_is_reversed (document, edge);
  if (acis_record_number (document, edge, 0u, &start)
      && acis_record_number (document, edge, 1u, &end)
      && isfinite (start) && isfinite (end)
      && fabs (end - start) > CURVE_EPSILON)
    {
      if (reversed)
        {
          if (!normalized_curve_sweep (end, start, &sweep))
            return 1;
          sweep = -sweep;
        }
      else if (!normalized_curve_sweep (start, end, &sweep))
        return 1;
      parameter_start = start;
    }
  else
    {
      start = acis_ellipse_parameter (
          center, major_axis, minor_axis, edge_start);
      end = acis_ellipse_parameter (
          center, major_axis, minor_axis, edge_end);
      if (!isfinite (start) || !isfinite (end))
        return 1;
      if (endpoint_distance_squared <= 1.0e-18)
        sweep = reversed ? -CURVE_FULL_TURN_RADIANS
                         : CURVE_FULL_TURN_RADIANS;
      else if (reversed)
        {
          if (!normalized_curve_sweep (end, start, &sweep))
            return 1;
          sweep = -sweep;
        }
      else if (!normalized_curve_sweep (start, end, &sweep))
        return 1;
      parameter_start = start;
    }
  segment_count = curve_segment_count (sweep);
  if (!segment_count)
    return 1;
  parameter_end = parameter_start + sweep;
  for (index = 0; index < segment_count; index++)
    {
      double local_start[3];
      double local_end[3];
      double first
          = parameter_start
            + (parameter_end - parameter_start) * (double)index
                  / (double)segment_count;
      double last
          = parameter_start
            + (parameter_end - parameter_start) * (double)(index + 1u)
                  / (double)segment_count;
      LineSegment segment = *base;
      if (*generated >= MAX_ACIS_SEGMENTS_PER_ENTITY)
        break;
      ellipse_point (
          center, major_axis, minor_axis, first, local_start);
      ellipse_point (
          center, major_axis, minor_axis, last, local_end);
      apply_acis_transform (transform, local_start, segment.start);
      apply_acis_transform (transform, local_end, segment.end);
      segment.source_kind = 6u;
      segment.approximated_curve = 1u;
      if (!segment_iteration_emit (iteration, &segment))
        return 0;
      (*generated)++;
      *handled = 1;
    }
  return 1;
}

static int
iterate_acis_segments (const Dwg_Object *object,
                       const CacheTables *tables,
                       SegmentIteration *iteration)
{
  AcisDocument document;
  LineSegment base;
  uint64_t generated = 0;
  size_t record_index;
  if (!object || !object->tio.entity
      || (object->fixedtype != DWG_TYPE_REGION
          && object->fixedtype != DWG_TYPE__3DSOLID
          && object->fixedtype != DWG_TYPE_BODY))
    return 1;
  if (!initialize_entity_segment (object, tables, 0u, 0, &base))
    return 1;
  if (!parse_acis_entity_document (object, &document))
    return 1;
  for (record_index = 0; record_index < document.record_count;
       record_index++)
    {
      const AcisRecord *edge = &document.records[record_index];
      const AcisRecord *curve = NULL;
      AcisTransform transform;
      double local_start[3];
      double local_end[3];
      LineSegment segment = base;
      int64_t curve_pointer;
      int handled = 0;
      if (edge->kind != ACIS_RECORD_EDGE
          || generated >= MAX_ACIS_SEGMENTS_PER_ENTITY)
        continue;
      if (!acis_edge_endpoint (
              &document, edge, 0, local_start)
          || !acis_edge_endpoint (
              &document, edge, 1, local_end))
        {
          segment_iteration_reject (iteration);
          continue;
        }
      acis_edge_transform (&document, edge, &transform);
      if (acis_record_pointer_from_end (
              &document, edge, 0u, &curve_pointer))
        curve = find_acis_record (&document, curve_pointer);
      if (curve && curve->kind == ACIS_RECORD_ELLIPSE_CURVE)
        {
          if (!emit_acis_ellipse_edge (
                  &document, edge, curve, &transform,
                  local_start, local_end, &base, iteration,
                  &generated, &handled))
            {
              free_acis_document (&document);
              return 0;
            }
        }
      else if (curve && curve->kind == ACIS_RECORD_INTCURVE_CURVE)
        {
          if (!emit_acis_spline_edge (
                  &document, edge, curve, &transform, &base,
                  iteration, &generated, &handled))
            {
              free_acis_document (&document);
              return 0;
            }
        }
      if (handled)
        continue;
      apply_acis_transform (&transform, local_start, segment.start);
      apply_acis_transform (&transform, local_end, segment.end);
      segment.source_kind
          = curve && curve->kind == ACIS_RECORD_STRAIGHT_CURVE
                ? 0u
                : 7u;
      segment.approximated_curve
          = curve && curve->kind != ACIS_RECORD_STRAIGHT_CURVE;
      if (!segment_iteration_emit (iteration, &segment))
        {
          free_acis_document (&document);
          return 0;
        }
      generated++;
    }
  free_acis_document (&document);
  return 1;
}

typedef struct
{
  CacheWriter *writer;
  uint64_t count;
  double last[2];
  int has_last;
  int failed;
} ViewportClipCollector;

static int
viewport_clip_point_equal (const double left[2], const double right[2])
{
  return fabs (left[0] - right[0]) <= 1.0e-9
         && fabs (left[1] - right[1]) <= 1.0e-9;
}

static int
viewport_clip_collect_point (ViewportClipCollector *collector,
                             const double point[3])
{
  double candidate[2] = { point[0], point[1] };
  if (!isfinite (candidate[0]) || !isfinite (candidate[1]))
    return 1;
  if (collector->has_last
      && viewport_clip_point_equal (collector->last, candidate))
    return 1;
  if (collector->count >= MAX_VIEWPORT_CLIP_VERTICES_PER_BOUNDARY)
    {
      collector->failed = 1;
      return 0;
    }
  if (collector->writer
      && (!write_f64 (collector->writer, candidate[0])
          || !write_f64 (collector->writer, candidate[1])))
    {
      collector->failed = 1;
      return 0;
    }
  memcpy (collector->last, candidate, sizeof (collector->last));
  collector->has_last = 1;
  collector->count++;
  return 1;
}

static int
viewport_clip_collect_segment (void *context,
                               const LineSegment *segment)
{
  return viewport_clip_collect_point (
      (ViewportClipCollector *)context, segment->start);
}

static int
collect_viewport_clip_vertices (
    const Dwg_Data *dwg, const CacheTables *tables,
    const Dwg_Entity_VIEWPORT *viewport, CacheWriter *writer,
    uint32_t *vertex_count)
{
  Dwg_Object *clip_object;
  ViewportClipCollector collector;
  SegmentIteration iteration;
  if (vertex_count)
    *vertex_count = 0;
  if (!dwg || !tables || !viewport || !viewport->clip_boundary)
    return 1;
  clip_object
      = reference_object (dwg, viewport->clip_boundary);
  if (!clip_object || !clip_object->tio.entity)
    return 1;
  memset (&collector, 0, sizeof (collector));
  collector.writer = writer;
  if (clip_object->fixedtype == DWG_TYPE_CIRCLE
      && clip_object->tio.entity->tio.CIRCLE)
    {
      const Dwg_Entity_CIRCLE *circle
          = clip_object->tio.entity->tio.CIRCLE;
      double center[3] = { circle->center.x, circle->center.y,
                           circle->center.z };
      double normal[3] = { circle->extrusion.x,
                           circle->extrusion.y,
                           circle->extrusion.z };
      unsigned index;
      if (!isfinite (circle->radius)
          || fabs (circle->radius) <= CURVE_EPSILON)
        return 1;
      for (index = 0; index < VIEWPORT_CLIP_CURVE_SEGMENTS; index++)
        {
          double point[3];
          circular_ocs_point (
              center, circle->radius,
              CURVE_FULL_TURN_RADIANS * (double)index
                  / (double)VIEWPORT_CLIP_CURVE_SEGMENTS,
              normal, point);
          if (!viewport_clip_collect_point (&collector, point))
            return 0;
        }
    }
  else if (clip_object->fixedtype == DWG_TYPE_ELLIPSE
           && clip_object->tio.entity->tio.ELLIPSE)
    {
      const Dwg_Entity_ELLIPSE *ellipse
          = clip_object->tio.entity->tio.ELLIPSE;
      double center[3] = { ellipse->center.x, ellipse->center.y,
                           ellipse->center.z };
      double major_axis[3] = { ellipse->sm_axis.x,
                               ellipse->sm_axis.y,
                               ellipse->sm_axis.z };
      double normal[3] = { ellipse->extrusion.x,
                           ellipse->extrusion.y,
                           ellipse->extrusion.z };
      double minor_axis[3];
      double sweep;
      unsigned index;
      if (!normalized_curve_sweep (
              ellipse->start_angle, ellipse->end_angle, &sweep)
          || fabs (sweep - CURVE_FULL_TURN_RADIANS) > 1.0e-7
          || !ellipse_axes (
              major_axis, normal, ellipse->axis_ratio, minor_axis))
        return 1;
      for (index = 0; index < VIEWPORT_CLIP_CURVE_SEGMENTS; index++)
        {
          double point[3];
          ellipse_point (
              center, major_axis, minor_axis,
              ellipse->start_angle
                  + CURVE_FULL_TURN_RADIANS * (double)index
                        / (double)VIEWPORT_CLIP_CURVE_SEGMENTS,
              point);
          if (!viewport_clip_collect_point (&collector, point))
            return 0;
        }
    }
  else if (clip_object->fixedtype == DWG_TYPE_LWPOLYLINE
           || clip_object->fixedtype == DWG_TYPE_POLYLINE_2D)
    {
      PolylineInfo info;
      if (!read_polyline_info (clip_object, &info) || !info.closed)
        return 1;
      memset (&iteration, 0, sizeof (iteration));
      iteration.consumer = viewport_clip_collect_segment;
      iteration.consumer_context = &collector;
      if (!iterate_polyline_segments (
              clip_object, tables, &iteration))
        return 0;
    }
  else if (clip_object->fixedtype == DWG_TYPE_SPLINE
           && clip_object->tio.entity->tio.SPLINE
           && spline_is_closed (
               clip_object->tio.entity->tio.SPLINE))
    {
      memset (&iteration, 0, sizeof (iteration));
      iteration.consumer = viewport_clip_collect_segment;
      iteration.consumer_context = &collector;
      if (!iterate_spline_segments (
              clip_object, tables, &iteration))
        return 0;
    }
  else
    return 1;
  if (collector.failed)
    return 0;
  if (collector.count < 3
      || collector.count > UINT32_MAX)
    return 1;
  if (vertex_count)
    *vertex_count = (uint32_t)collector.count;
  return 1;
}

static uint32_t
viewport_clip_vertex_count (const Dwg_Data *dwg,
                            const CacheTables *tables,
                            const Dwg_Entity_VIEWPORT *viewport)
{
  uint32_t count = 0;
  if (!collect_viewport_clip_vertices (
          dwg, tables, viewport, NULL, &count))
    return 0;
  return count;
}

static int
write_viewport_clip_vertex_section (
    CacheWriter *writer, const Dwg_Data *dwg,
    const CacheTables *tables, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t layout_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (layout_index = 0; layout_index < (size_t)dwg->num_objects;
       layout_index++)
    {
      const Dwg_Object *layout_object = &dwg->object[layout_index];
      uint64_t block_handle;
      size_t object_index;
      if (!is_layout_object (layout_object))
        continue;
      block_handle = reference_handle (
          layout_object->tio.object->tio.LAYOUT->block_header);
      for (object_index = 0; object_index < (size_t)dwg->num_objects;
           object_index++)
        {
          const Dwg_Object *object = &dwg->object[object_index];
          const Dwg_Entity_VIEWPORT *viewport;
          uint32_t expected;
          uint32_t written = 0;
          if (!is_viewport_entity (object)
              || entity_owner_handle (object->tio.entity, tables)
                     != block_handle)
            continue;
          viewport = object->tio.entity->tio.VIEWPORT;
          expected = viewport_clip_vertex_count (
              dwg, tables, viewport);
          if (!expected)
            continue;
          if (!collect_viewport_clip_vertices (
                  dwg, tables, viewport, writer, &written)
              || written != expected
              || count > MAX_VIEWPORT_CLIP_VERTICES - written)
            {
              set_error (
                  writer, "cannot serialize viewport clip boundary");
              return 0;
            }
          count += written;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_VIEWPORT_CLIP_VERTICES,
      VIEWPORT_CLIP_VERTEX_RECORD_SIZE, "viewport_clip_vertices",
      offset, count);
}

static int
hatch_curve_parameters (double start, double end, int is_ccw,
                        double *first, double *sweep)
{
  /*
   * LibreDWG exposes clockwise HATCH arc and ellipse parameters in the
   * boundary edge's clockwise OCS convention.  Reflect those angles across
   * the OCS X axis before evaluating them with the ordinary mathematical
   * cos/sin basis below.  Merely reversing start and end mirrors the curve
   * onto the opposite side of its center, disconnecting otherwise closed
   * HATCH rings and leaving only their erroneous fallback boundaries visible.
   */
  if (!is_ccw)
    {
      double magnitude;
      start = -start;
      end = -end;
      if (!normalized_curve_sweep (end, start, &magnitude))
        return 0;
      *first = start;
      *sweep = -magnitude;
      return 1;
    }
  *first = start;
  return normalized_curve_sweep (start, end, sweep);
}

static int
read_hatch_spline_sampling (const Dwg_HATCH_PathSeg *segment,
                            SplineSampling *sampling)
{
  size_t degree;
  size_t control_count;
  size_t knot_count;
  size_t required_knots;
  size_t nonzero_spans = 0;
  size_t requested_segments;
  size_t index;
  int has_nonzero_weight = 0;
  double domain_range;
  if (!segment || !sampling || segment->degree <= 0
      || (uint64_t)segment->degree > MAX_SPLINE_DEGREE
      || !segment->control_points || !segment->knots)
    return 0;
  degree = (size_t)segment->degree;
  control_count = (size_t)segment->num_control_points;
  knot_count = (size_t)segment->num_knots;
  if (control_count <= degree
      || control_count > SIZE_MAX - degree - 1u)
    return 0;
  required_knots = control_count + degree + 1u;
  if (knot_count < required_knots)
    return 0;
  for (index = 0; index < knot_count; index++)
    {
      if (!isfinite (segment->knots[index])
          || (index
              && segment->knots[index - 1u]
                     > segment->knots[index]))
        return 0;
    }
  for (index = 0; index < control_count; index++)
    {
      const Dwg_HATCH_ControlPoint *control
          = &segment->control_points[index];
      if (!isfinite (control->point.x)
          || !isfinite (control->point.y)
          || !isfinite (control->weight))
        return 0;
      if (fabs (control->weight) > CURVE_EPSILON)
        has_nonzero_weight = 1;
    }
  if (segment->is_rational && !has_nonzero_weight)
    return 0;
  sampling->domain_start = segment->knots[degree];
  sampling->domain_end = segment->knots[control_count];
  domain_range = sampling->domain_end - sampling->domain_start;
  if (!isfinite (domain_range) || domain_range <= CURVE_EPSILON)
    return 0;
  for (index = degree; index < control_count; index++)
    {
      double span
          = segment->knots[index + 1u] - segment->knots[index];
      if (!isfinite (span))
        return 0;
      if (span > CURVE_EPSILON)
        nonzero_spans++;
    }
  if (!nonzero_spans)
    return 0;
  sampling->segments_per_span
      = degree == 1u ? 1u : HATCH_SPLINE_SEGMENTS_PER_SPAN;
  if (nonzero_spans > SIZE_MAX / sampling->segments_per_span)
    return 0;
  requested_segments
      = nonzero_spans * sampling->segments_per_span;
  sampling->degree = degree;
  sampling->control_count = control_count;
  sampling->nonzero_spans = nonzero_spans;
  sampling->segment_count
      = requested_segments > MAX_HATCH_SPLINE_SEGMENTS
            ? MAX_HATCH_SPLINE_SEGMENTS
            : (unsigned)requested_segments;
  sampling->uniform_domain
      = requested_segments > MAX_HATCH_SPLINE_SEGMENTS;
  return sampling->segment_count != 0;
}

static int
hatch_spline_segment_parameters (
    const Dwg_HATCH_PathSeg *segment,
    const SplineSampling *sampling, unsigned segment_index,
    double *start, double *end)
{
  size_t span_ordinal;
  size_t subdivision;
  size_t current_span = 0;
  size_t knot_index;
  if (!segment || !sampling || !start || !end
      || segment_index >= sampling->segment_count)
    return 0;
  if (sampling->uniform_domain)
    {
      double scale
          = (sampling->domain_end - sampling->domain_start)
            / (double)sampling->segment_count;
      *start = sampling->domain_start
               + scale * (double)segment_index;
      *end = sampling->domain_start
             + scale * (double)(segment_index + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  span_ordinal
      = (size_t)segment_index / sampling->segments_per_span;
  subdivision
      = (size_t)segment_index % sampling->segments_per_span;
  if (span_ordinal >= sampling->nonzero_spans)
    return 0;
  for (knot_index = sampling->degree;
       knot_index < sampling->control_count; knot_index++)
    {
      double span_start = segment->knots[knot_index];
      double span_end = segment->knots[knot_index + 1u];
      double scale;
      if (span_end - span_start <= CURVE_EPSILON)
        continue;
      if (current_span++ != span_ordinal)
        continue;
      scale
          = (span_end - span_start)
            / (double)sampling->segments_per_span;
      *start = span_start + scale * (double)subdivision;
      *end = span_start + scale * (double)(subdivision + 1u);
      return isfinite (*start) && isfinite (*end);
    }
  return 0;
}

static int
evaluate_hatch_spline (const Dwg_HATCH_PathSeg *segment,
                       const SplineSampling *sampling,
                       double parameter, double elevation,
                       double point[3])
{
  double points[MAX_SPLINE_DEGREE + 1u][3];
  double weights[MAX_SPLINE_DEGREE + 1u];
  size_t span = SIZE_MAX;
  size_t level;
  size_t index;
  size_t axis;
  if (!segment || !sampling || !point || !isfinite (parameter)
      || !isfinite (elevation))
    return 0;
  if (parameter >= sampling->domain_end - CURVE_EPSILON)
    span = sampling->control_count - 1u;
  else
    {
      for (index = sampling->degree;
           index < sampling->control_count; index++)
        {
          if (segment->knots[index] <= parameter
              && parameter < segment->knots[index + 1u])
            {
              span = index;
              break;
            }
        }
    }
  if (span == SIZE_MAX || span < sampling->degree)
    return 0;
  for (index = 0; index <= sampling->degree; index++)
    {
      size_t control_index
          = span - sampling->degree + index;
      const Dwg_HATCH_ControlPoint *control
          = &segment->control_points[control_index];
      double weight
          = segment->is_rational ? control->weight : 1.0;
      if (!isfinite (control->point.x)
          || !isfinite (control->point.y)
          || !isfinite (weight))
        return 0;
      points[index][0] = control->point.x * weight;
      points[index][1] = control->point.y * weight;
      points[index][2] = elevation * weight;
      weights[index] = weight;
    }
  for (level = 1; level <= sampling->degree; level++)
    {
      for (index = sampling->degree; index >= level; index--)
        {
          size_t knot_index
              = span - sampling->degree + index;
          double denominator
              = segment
                    ->knots[knot_index + sampling->degree - level
                            + 1u]
                - segment->knots[knot_index];
          double alpha;
          if (fabs (denominator) <= CURVE_EPSILON)
            alpha = 0.0;
          else
            {
              alpha
                  = (parameter - segment->knots[knot_index])
                    / denominator;
              if (alpha < 0.0)
                alpha = 0.0;
              else if (alpha > 1.0)
                alpha = 1.0;
            }
          for (axis = 0; axis < 3; axis++)
            points[index][axis]
                = points[index - 1u][axis] * (1.0 - alpha)
                  + points[index][axis] * alpha;
          weights[index]
              = weights[index - 1u] * (1.0 - alpha)
                + weights[index] * alpha;
        }
    }
  if (!isfinite (weights[sampling->degree])
      || fabs (weights[sampling->degree]) <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3; axis++)
    point[axis]
        = points[sampling->degree][axis]
          / weights[sampling->degree];
  return 1;
}

static int
hatch_fit_points_near (const BITCODE_2RD *left,
                       const BITCODE_2RD *right)
{
  double scale;
  double tolerance;
  if (!left || !right || !isfinite (left->x)
      || !isfinite (left->y) || !isfinite (right->x)
      || !isfinite (right->y))
    return 0;
  scale = fmax (1.0, fabs (left->x));
  scale = fmax (scale, fabs (left->y));
  scale = fmax (scale, fabs (right->x));
  scale = fmax (scale, fabs (right->y));
  tolerance = fmax (CURVE_EPSILON, scale * DBL_EPSILON * 64.0);
  return fabs (left->x - right->x) <= tolerance
         && fabs (left->y - right->y) <= tolerance;
}

static double
hatch_fit_interval (const Dwg_HATCH_PathSeg *segment,
                    size_t first, size_t second)
{
  double delta_x;
  double delta_y;
  if (!segment || !segment->fitpts
      || first >= (size_t)segment->num_fitpts
      || second >= (size_t)segment->num_fitpts)
    return 0.0;
  delta_x = segment->fitpts[second].x - segment->fitpts[first].x;
  delta_y = segment->fitpts[second].y - segment->fitpts[first].y;
  return hypot (delta_x, delta_y);
}

static int
read_hatch_fit_sampling (const Dwg_HATCH_PathSeg *segment,
                         HatchFitSampling *sampling)
{
  size_t point_count;
  size_t source_segment_count;
  size_t index;
  int periodic;
  if (!segment || !sampling || !segment->fitpts
      || segment->num_fitpts < 2u)
    return 0;
  point_count = (size_t)segment->num_fitpts;
  for (index = 0; index < point_count; index++)
    {
      if (!isfinite (segment->fitpts[index].x)
          || !isfinite (segment->fitpts[index].y))
        return 0;
    }
  periodic = segment->is_periodic && point_count >= 3u;
  if (periodic
      && hatch_fit_points_near (
          &segment->fitpts[0], &segment->fitpts[point_count - 1u]))
    point_count--;
  if ((periodic && point_count < 3u) || point_count < 2u)
    return 0;
  source_segment_count
      = point_count - 1u + (periodic ? 1u : 0u);
  for (index = 0; index < source_segment_count; index++)
    {
      size_t next = (index + 1u) % point_count;
      double interval = hatch_fit_interval (segment, index, next);
      if (!isfinite (interval) || interval <= CURVE_EPSILON)
        return 0;
    }
  sampling->point_count = point_count;
  sampling->source_segment_count = source_segment_count;
  sampling->segment_count
      = source_segment_count
                > MAX_HATCH_SPLINE_SEGMENTS
                      / HATCH_SPLINE_SEGMENTS_PER_SPAN
            ? MAX_HATCH_SPLINE_SEGMENTS
            : (unsigned)(source_segment_count
                         * HATCH_SPLINE_SEGMENTS_PER_SPAN);
  sampling->periodic = periodic;
  return sampling->segment_count != 0;
}

static int
hatch_fit_explicit_tangent (const BITCODE_2RD *source,
                            double tangent[2])
{
  if (!source || !tangent || !isfinite (source->x)
      || !isfinite (source->y)
      || hypot (source->x, source->y) <= CURVE_EPSILON)
    return 0;
  tangent[0] = source->x;
  tangent[1] = source->y;
  return 1;
}

static int
hatch_fit_tangent (const Dwg_HATCH_PathSeg *segment,
                   const HatchFitSampling *sampling, size_t index,
                   double tangent[2])
{
  size_t previous;
  size_t next;
  double previous_interval;
  double next_interval;
  size_t axis;
  if (!segment || !sampling || !tangent
      || index >= sampling->point_count)
    return 0;
  if (!sampling->periodic && index == 0u
      && hatch_fit_explicit_tangent (
          &segment->start_tangent, tangent))
    return 1;
  if (!sampling->periodic && index + 1u == sampling->point_count
      && hatch_fit_explicit_tangent (
          &segment->end_tangent, tangent))
    return 1;
  if (!sampling->periodic && index == 0u)
    {
      next_interval = hatch_fit_interval (segment, 0u, 1u);
      if (!isfinite (next_interval)
          || next_interval <= CURVE_EPSILON)
        return 0;
      tangent[0]
          = (segment->fitpts[1].x - segment->fitpts[0].x)
            / next_interval;
      tangent[1]
          = (segment->fitpts[1].y - segment->fitpts[0].y)
            / next_interval;
      return 1;
    }
  if (!sampling->periodic && index + 1u == sampling->point_count)
    {
      previous = index - 1u;
      previous_interval
          = hatch_fit_interval (segment, previous, index);
      if (!isfinite (previous_interval)
          || previous_interval <= CURVE_EPSILON)
        return 0;
      tangent[0]
          = (segment->fitpts[index].x
             - segment->fitpts[previous].x)
            / previous_interval;
      tangent[1]
          = (segment->fitpts[index].y
             - segment->fitpts[previous].y)
            / previous_interval;
      return 1;
    }
  previous
      = (index + sampling->point_count - 1u)
        % sampling->point_count;
  next = (index + 1u) % sampling->point_count;
  previous_interval
      = hatch_fit_interval (segment, previous, index);
  next_interval = hatch_fit_interval (segment, index, next);
  if (!isfinite (previous_interval)
      || !isfinite (next_interval)
      || previous_interval <= CURVE_EPSILON
      || next_interval <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 2u; axis++)
    {
      double previous_value
          = axis ? segment->fitpts[previous].y
                 : segment->fitpts[previous].x;
      double current_value
          = axis ? segment->fitpts[index].y
                 : segment->fitpts[index].x;
      double next_value
          = axis ? segment->fitpts[next].y
                 : segment->fitpts[next].x;
      double previous_slope
          = (current_value - previous_value) / previous_interval;
      double next_slope
          = (next_value - current_value) / next_interval;
      tangent[axis]
          = (previous_slope * next_interval
             + next_slope * previous_interval)
            / (previous_interval + next_interval);
    }
  return isfinite (tangent[0]) && isfinite (tangent[1]);
}

static int
evaluate_hatch_fit_boundary (
    const Dwg_HATCH_PathSeg *segment,
    const HatchFitSampling *sampling, unsigned boundary_index,
    double elevation, double point[3])
{
  double scaled;
  size_t source_index;
  size_t next_index;
  double local_parameter;
  double interval;
  double start_tangent[2];
  double end_tangent[2];
  double inverse;
  double start_basis;
  double start_tangent_basis;
  double end_basis;
  double end_tangent_basis;
  size_t axis;
  if (!segment || !sampling || !point
      || boundary_index > sampling->segment_count
      || !sampling->segment_count)
    return 0;
  if (boundary_index == sampling->segment_count)
    {
      source_index = sampling->source_segment_count - 1u;
      local_parameter = 1.0;
    }
  else
    {
      scaled
          = (double)boundary_index
            * (double)sampling->source_segment_count
            / (double)sampling->segment_count;
      source_index = (size_t)floor (scaled);
      if (source_index >= sampling->source_segment_count)
        source_index = sampling->source_segment_count - 1u;
      local_parameter = scaled - (double)source_index;
    }
  next_index = (source_index + 1u) % sampling->point_count;
  interval = hatch_fit_interval (segment, source_index, next_index);
  if (!isfinite (interval) || interval <= CURVE_EPSILON
      || !hatch_fit_tangent (
          segment, sampling, source_index, start_tangent)
      || !hatch_fit_tangent (
          segment, sampling, next_index, end_tangent))
    return 0;
  inverse = 1.0 - local_parameter;
  start_basis
      = inverse * inverse * (1.0 + 2.0 * local_parameter);
  start_tangent_basis
      = local_parameter * inverse * inverse * interval;
  end_basis
      = local_parameter * local_parameter
        * (3.0 - 2.0 * local_parameter);
  end_tangent_basis
      = local_parameter * local_parameter
        * (local_parameter - 1.0) * interval;
  for (axis = 0; axis < 2u; axis++)
    {
      double start_value
          = axis ? segment->fitpts[source_index].y
                 : segment->fitpts[source_index].x;
      double end_value
          = axis ? segment->fitpts[next_index].y
                 : segment->fitpts[next_index].x;
      point[axis]
          = start_basis * start_value
            + start_tangent_basis * start_tangent[axis]
            + end_basis * end_value
            + end_tangent_basis * end_tangent[axis];
    }
  point[2] = elevation;
  return isfinite (point[0]) && isfinite (point[1])
         && isfinite (point[2]);
}

static size_t
hatch_spline_control_point_count (
    const Dwg_HATCH_PathSeg *segment)
{
  return segment && segment->control_points
             ? (size_t)segment->num_control_points
             : 0u;
}

static unsigned
hatch_spline_fallback_segment_count (
    const Dwg_HATCH_PathSeg *segment)
{
  HatchFitSampling fit_sampling;
  size_t point_count;
  size_t source_segments;
  memset (&fit_sampling, 0, sizeof (fit_sampling));
  if (read_hatch_fit_sampling (segment, &fit_sampling))
    return fit_sampling.segment_count;
  point_count = hatch_spline_control_point_count (segment);
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (segment->is_periodic ? 1u : 0u);
  return source_segments > MAX_HATCH_SPLINE_SEGMENTS
             ? MAX_HATCH_SPLINE_SEGMENTS
             : (unsigned)source_segments;
}

static int
hatch_spline_fallback_segment (
    const Dwg_HATCH_PathSeg *segment, unsigned segment_index,
    double elevation, double start[3], double end[3])
{
  HatchFitSampling fit_sampling;
  size_t point_count;
  size_t source_segments;
  unsigned output_segments;
  size_t start_index;
  size_t end_index;
  memset (&fit_sampling, 0, sizeof (fit_sampling));
  if (read_hatch_fit_sampling (segment, &fit_sampling))
    {
      if (segment_index >= fit_sampling.segment_count)
        return 0;
      return evaluate_hatch_fit_boundary (
                 segment, &fit_sampling, segment_index,
                 elevation, start)
             && evaluate_hatch_fit_boundary (
                 segment, &fit_sampling, segment_index + 1u,
                 elevation, end);
    }
  point_count = hatch_spline_control_point_count (segment);
  if (point_count < 2u)
    return 0;
  source_segments
      = point_count - 1u
        + (segment->is_periodic ? 1u : 0u);
  output_segments
      = source_segments > MAX_HATCH_SPLINE_SEGMENTS
            ? MAX_HATCH_SPLINE_SEGMENTS
            : (unsigned)source_segments;
  if (!output_segments || segment_index >= output_segments)
    return 0;
  start_index
      = (size_t)((uint64_t)segment_index * source_segments
                 / output_segments)
        % point_count;
  end_index
      = (size_t)((uint64_t)(segment_index + 1u)
                     * source_segments
                 / output_segments)
        % point_count;
  start[0] = segment->control_points[start_index].point.x;
  start[1] = segment->control_points[start_index].point.y;
  start[2] = elevation;
  end[0] = segment->control_points[end_index].point.x;
  end[1] = segment->control_points[end_index].point.y;
  end[2] = elevation;
  return isfinite (start[0]) && isfinite (start[1])
         && isfinite (start[2]) && isfinite (end[0])
         && isfinite (end[1]) && isfinite (end[2]);
}

static int
emit_hatch_ocs_segment (SegmentIteration *iteration,
                        const LineSegment *base,
                        const double normal[3],
                        const double start_ocs[3],
                        const double end_ocs[3],
                        int approximated_curve,
                        uint64_t *generated)
{
  LineSegment segment = *base;
  if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
    return 1;
  ocs_to_wcs (normal, start_ocs, segment.start);
  ocs_to_wcs (normal, end_ocs, segment.end);
  segment.approximated_curve
      = approximated_curve ? 1u : 0u;
  (*generated)++;
  return segment_iteration_emit (iteration, &segment);
}

static int
iterate_hatch_polyline_path (
    const Dwg_HATCH_Path *path, double elevation,
    const double normal[3], const LineSegment *base,
    SegmentIteration *iteration, uint64_t *generated)
{
  size_t count;
  size_t source_index;
  size_t source_segments;
  if (!path || !path->polyline_paths
      || !path->num_segs_or_paths)
    return 1;
  count = (size_t)path->num_segs_or_paths;
  source_segments
      = count > 1u
            ? count - 1u + (path->closed ? 1u : 0u)
            : 0u;
  for (source_index = 0; source_index < source_segments;
       source_index++)
    {
      const Dwg_HATCH_PolylinePath *start
          = &path->polyline_paths[source_index];
      const Dwg_HATCH_PolylinePath *end
          = &path->polyline_paths[(source_index + 1u) % count];
      PolylineVertex start_vertex;
      PolylineVertex end_vertex;
      double bulge
          = path->bulges_present ? start->bulge : 0.0;
      unsigned subdivisions = hatch_bulge_segment_count (bulge);
      unsigned subdivision;
      memset (&start_vertex, 0, sizeof (start_vertex));
      memset (&end_vertex, 0, sizeof (end_vertex));
      start_vertex.position[0] = start->point.x;
      start_vertex.position[1] = start->point.y;
      start_vertex.position[2] = elevation;
      start_vertex.bulge = bulge;
      end_vertex.position[0] = end->point.x;
      end_vertex.position[1] = end->point.y;
      end_vertex.position[2] = elevation;
      for (subdivision = 0; subdivision < subdivisions;
           subdivision++)
        {
          double start_ocs[3];
          double end_ocs[3];
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          if (!bulge_point (
                  &start_vertex, &end_vertex, elevation, subdivision,
                  subdivisions, start_ocs)
              || !bulge_point (
                  &start_vertex, &end_vertex, elevation,
                  subdivision + 1u, subdivisions, end_ocs))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start_ocs, end_ocs,
                  isfinite (bulge)
                      && fabs (bulge) > CURVE_EPSILON,
                  generated))
            return 0;
        }
    }
  return 1;
}

static int
iterate_hatch_edge (
    const Dwg_HATCH_PathSeg *edge, double elevation,
    const double normal[3], const LineSegment *base,
    SegmentIteration *iteration, uint64_t *generated)
{
  if (!edge || *generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
    return 1;
  if (edge->curve_type == 1u)
    {
      double start[3]
          = { edge->first_endpoint.x, edge->first_endpoint.y,
              elevation };
      double end[3]
          = { edge->second_endpoint.x,
              edge->second_endpoint.y, elevation };
      return emit_hatch_ocs_segment (
          iteration, base, normal, start, end, 0, generated);
    }
  if (edge->curve_type == 2u)
    {
      double first;
      double sweep;
      unsigned count;
      unsigned index;
      if (!isfinite (edge->radius)
          || fabs (edge->radius) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 1;
      count = hatch_curve_segment_count (sweep);
      for (index = 0; index < count; index++)
        {
          double start_angle
              = first + sweep * (double)index / (double)count;
          double end_angle
              = first
                + sweep * (double)(index + 1u) / (double)count;
          double start[3]
              = { edge->center.x
                      + edge->radius * cos (start_angle),
                  edge->center.y
                      + edge->radius * sin (start_angle),
                  elevation };
          double end[3]
              = { edge->center.x
                      + edge->radius * cos (end_angle),
                  edge->center.y
                      + edge->radius * sin (end_angle),
                  elevation };
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start, end, 1,
                  generated))
            return 0;
        }
      return 1;
    }
  if (edge->curve_type == 3u)
    {
      double first;
      double sweep;
      double major[3]
          = { edge->endpoint.x, edge->endpoint.y, 0.0 };
      double major_length = hypot (major[0], major[1]);
      double minor[3];
      double center[3]
          = { edge->center.x, edge->center.y, elevation };
      unsigned count;
      unsigned index;
      if (!isfinite (major_length)
          || major_length <= CURVE_EPSILON
          || !isfinite (edge->minor_major_ratio)
          || fabs (edge->minor_major_ratio) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 1;
      minor[0] = -major[1] * fabs (edge->minor_major_ratio);
      minor[1] = major[0] * fabs (edge->minor_major_ratio);
      minor[2] = 0.0;
      count = hatch_curve_segment_count (sweep);
      for (index = 0; index < count; index++)
        {
          double start_parameter
              = first + sweep * (double)index / (double)count;
          double end_parameter
              = first
                + sweep * (double)(index + 1u) / (double)count;
          double start[3];
          double end[3];
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          ellipse_point (
              center, major, minor, start_parameter, start);
          ellipse_point (
              center, major, minor, end_parameter, end);
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start, end, 1,
                  generated))
            return 0;
        }
      return 1;
    }
  if (edge->curve_type == 4u)
    {
      SplineSampling sampling;
      unsigned count;
      unsigned index;
      memset (&sampling, 0, sizeof (sampling));
      if (read_hatch_spline_sampling (edge, &sampling))
        {
          count = sampling.segment_count;
          for (index = 0; index < count; index++)
            {
              double start_parameter;
              double end_parameter;
              double start[3];
              double end[3];
              if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
                return 1;
              if (!hatch_spline_segment_parameters (
                      edge, &sampling, index, &start_parameter,
                      &end_parameter)
                  || !evaluate_hatch_spline (
                      edge, &sampling, start_parameter, elevation,
                      start)
                  || !evaluate_hatch_spline (
                      edge, &sampling, end_parameter, elevation,
                      end))
                {
                  segment_iteration_reject (iteration);
                  continue;
                }
              if (!emit_hatch_ocs_segment (
                      iteration, base, normal, start, end,
                      sampling.degree > 1u, generated))
                return 0;
            }
          return 1;
        }
      count = hatch_spline_fallback_segment_count (edge);
      for (index = 0; index < count; index++)
        {
          double start[3];
          double end[3];
          if (*generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
          if (!hatch_spline_fallback_segment (
                  edge, index, elevation, start, end))
            {
              segment_iteration_reject (iteration);
              continue;
            }
          if (!emit_hatch_ocs_segment (
                  iteration, base, normal, start, end, 1,
                  generated))
            return 0;
        }
    }
  return 1;
}

static int
iterate_hatch_boundary_segments (const Dwg_Object *object,
                                 const CacheTables *tables,
                                 SegmentIteration *iteration)
{
  const Dwg_Entity_HATCH *hatch;
  LineSegment base;
  double normal[3];
  uint64_t generated = 0;
  size_t path_count;
  size_t path_index;
  if (!object || object->fixedtype != DWG_TYPE_HATCH
      || !object->tio.entity
      || !(hatch = object->tio.entity->tio.HATCH)
      || !hatch->paths || !hatch->num_paths)
    return 1;
  if (!initialize_entity_segment (object, tables, 8, 0, &base))
    return 1;
  finite_normal_or_unit_z (
      hatch->extrusion.x, hatch->extrusion.y,
      hatch->extrusion.z, normal);
  path_count = (size_t)hatch->num_paths;
  for (path_index = 0; path_index < path_count; path_index++)
    {
      const Dwg_HATCH_Path *path = &hatch->paths[path_index];
      size_t edge_count;
      size_t edge_index;
      if (generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
        return 1;
      if ((path->flag & 2u) != 0u)
        {
          if (!iterate_hatch_polyline_path (
                  path, hatch->elevation, normal, &base, iteration,
                  &generated))
            return 0;
          continue;
        }
      if (!path->segs || !path->num_segs_or_paths)
        continue;
      edge_count = (size_t)path->num_segs_or_paths;
      for (edge_index = 0; edge_index < edge_count; edge_index++)
        {
          if (!iterate_hatch_edge (
                  &path->segs[edge_index], hatch->elevation, normal,
                  &base, iteration, &generated))
            return 0;
          if (generated >= MAX_HATCH_BOUNDARY_SEGMENTS)
            return 1;
        }
    }
  return 1;
}

static int
iterate_gpu_segments (const Dwg_Data *dwg, const CacheTables *tables,
                      OverviewPlan *overview,
                      LineSegmentConsumer consumer, void *context,
                      uint64_t *selected, uint64_t *skipped,
                      uint64_t *approximated)
{
  SegmentIteration iteration;
  size_t i;
  memset (&iteration, 0, sizeof (iteration));
  iteration.overview = overview;
  iteration.consumer = consumer;
  iteration.consumer_context = context;
  if (overview)
    reset_overview_plan (overview);
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      LineSegment segment;
      int status = line_segment_from_object (object, tables, &segment);
      if (status == 0)
        status = construction_line_segment_from_object (
            dwg, object, tables, &segment);
      if (status < 0)
        iteration.skipped++;
      else if (status > 0)
        {
          if (!segment_iteration_emit (&iteration, &segment))
            return 0;
        }
      else if (!iterate_polyline_segments (
                   object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_polyline_mesh_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_mline_segments (object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_analytic_curve_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_spline_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_proxy_graphic_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_acis_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_hatch_boundary_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_mleader_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_leader_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_ole2frame_segments (
              object, tables, &iteration))
        return 0;
      if (status == 0
          && !iterate_viewport_frame_segments (
              dwg, object, tables, &iteration))
        return 0;
    }
  if (selected)
    *selected = iteration.emitted;
  if (skipped)
    *skipped = iteration.skipped;
  if (approximated)
    *approximated = iteration.approximated;
  if (overview && iteration.emitted != overview->quota_total)
    return 0;
  return 1;
}

typedef struct
{
  LibreDwgGpuLineSummary *summary;
  OverviewPlan *overview;
} GpuSegmentCounter;

static int
count_gpu_segment (void *context, const LineSegment *segment)
{
  GpuSegmentCounter *counter = (GpuSegmentCounter *)context;
  size_t index = overview_group_index (segment, counter->overview);
  double midpoint[2];
  size_t axis;
  if (segment->group == UINT32_MAX)
    counter->summary->model_segments++;
  else
    counter->summary->block_segments++;
  if (segment->source_kind == 8u)
    counter->summary->hatch_boundary_segments++;
  if (index < counter->overview->group_count)
    {
      OverviewGroup *group = &counter->overview->groups[index];
      group->count++;
      midpoint[0] = segment->start[0] * 0.5 + segment->end[0] * 0.5;
      midpoint[1] = segment->start[1] * 0.5 + segment->end[1] * 0.5;
      if (!group->has_midpoint_bounds)
        {
          for (axis = 0; axis < 2; axis++)
            group->midpoint_min[axis] = group->midpoint_max[axis]
                = midpoint[axis];
          group->has_midpoint_bounds = 1;
        }
      else
        {
          for (axis = 0; axis < 2; axis++)
            {
              group->midpoint_min[axis]
                  = fmin (group->midpoint_min[axis], midpoint[axis]);
              group->midpoint_max[axis]
                  = fmax (group->midpoint_max[axis], midpoint[axis]);
            }
        }
    }
  return 1;
}

static uint64_t
bounded_hatch_segment_sum (uint64_t total, uint64_t additional)
{
  uint64_t marker = (uint64_t)MAX_HATCH_BOUNDARY_SEGMENTS + 1u;
  if (total >= marker || additional >= marker
      || additional > marker - total)
    return marker;
  return total + additional;
}

static uint64_t
hatch_edge_requested_segments (const Dwg_HATCH_PathSeg *edge)
{
  double first;
  double sweep;
  if (!edge)
    return 0;
  if (edge->curve_type == 1u)
    return 1;
  if (edge->curve_type == 2u)
    {
      if (!isfinite (edge->radius)
          || fabs (edge->radius) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 0;
      return hatch_curve_segment_count (sweep);
    }
  if (edge->curve_type == 3u)
    {
      double major_length
          = hypot (edge->endpoint.x, edge->endpoint.y);
      if (!isfinite (major_length)
          || major_length <= CURVE_EPSILON
          || !isfinite (edge->minor_major_ratio)
          || fabs (edge->minor_major_ratio) <= CURVE_EPSILON
          || !hatch_curve_parameters (
              edge->start_angle, edge->end_angle, edge->is_ccw,
              &first, &sweep))
        return 0;
      return hatch_curve_segment_count (sweep);
    }
  if (edge->curve_type == 4u)
    {
      SplineSampling sampling;
      memset (&sampling, 0, sizeof (sampling));
      if (read_hatch_spline_sampling (edge, &sampling))
        return sampling.segment_count;
      return hatch_spline_fallback_segment_count (edge);
    }
  return 0;
}

static uint64_t
hatch_requested_boundary_segments (const Dwg_Entity_HATCH *hatch)
{
  uint64_t total = 0;
  uint64_t marker = (uint64_t)MAX_HATCH_BOUNDARY_SEGMENTS + 1u;
  size_t path_count;
  size_t path_index;
  if (!hatch || !hatch->paths || !hatch->num_paths)
    return 0;
  path_count = (size_t)hatch->num_paths;
  for (path_index = 0; path_index < path_count; path_index++)
    {
      const Dwg_HATCH_Path *path = &hatch->paths[path_index];
      size_t item_count;
      size_t item_index;
      if ((path->flag & 2u) != 0u)
        {
          size_t source_segments;
          if (!path->polyline_paths
              || path->num_segs_or_paths < 2u)
            continue;
          item_count = (size_t)path->num_segs_or_paths;
          source_segments
              = item_count - 1u + (path->closed ? 1u : 0u);
          for (item_index = 0; item_index < source_segments;
               item_index++)
            {
              double bulge
                  = path->bulges_present
                        ? path->polyline_paths[item_index].bulge
                        : 0.0;
              total = bounded_hatch_segment_sum (
                  total, hatch_bulge_segment_count (bulge));
              if (total >= marker)
                return marker;
            }
          continue;
        }
      if (!path->segs || !path->num_segs_or_paths)
        continue;
      item_count = (size_t)path->num_segs_or_paths;
      for (item_index = 0; item_index < item_count; item_index++)
        {
          total = bounded_hatch_segment_sum (
              total,
              hatch_edge_requested_segments (&path->segs[item_index]));
          if (total >= marker)
            return marker;
        }
    }
  return total;
}

enum
{
  HATCH_RING_ERROR = -1,
  HATCH_RING_INVALID = 0,
  HATCH_RING_VALID = 1,
  HATCH_RING_OPEN = 2,
  HATCH_RING_TRUNCATED = 3
};

static uint64_t
hatch_path_requested_segments (const Dwg_HATCH_Path *path)
{
  uint64_t total = 0;
  uint64_t marker = (uint64_t)MAX_HATCH_BOUNDARY_SEGMENTS + 1u;
  size_t item_count;
  size_t item_index;
  if (!path || !path->num_segs_or_paths)
    return 0;
  item_count = (size_t)path->num_segs_or_paths;
  if ((path->flag & 2u) != 0u)
    {
      size_t source_segments;
      if (!path->polyline_paths || item_count < 2u)
        return 0;
      source_segments
          = item_count - 1u + (path->closed ? 1u : 0u);
      for (item_index = 0; item_index < source_segments;
           item_index++)
        {
          double bulge
              = path->bulges_present
                    ? path->polyline_paths[item_index].bulge
                    : 0.0;
          total = bounded_hatch_segment_sum (
              total, hatch_bulge_segment_count (bulge));
          if (total >= marker)
            return marker;
        }
      return total;
    }
  if (!path->segs)
    return 0;
  for (item_index = 0; item_index < item_count; item_index++)
    {
      uint64_t requested
          = hatch_edge_requested_segments (&path->segs[item_index]);
      if (!requested)
        return 0;
      total = bounded_hatch_segment_sum (total, requested);
      if (total >= marker)
        return marker;
    }
  return total;
}

static int
collect_hatch_segment (void *context, const LineSegment *segment)
{
  HatchSegmentCollector *collector = (HatchSegmentCollector *)context;
  if (!collector || !segment || collector->count >= collector->capacity)
    return 0;
  collector->segments[collector->count++] = *segment;
  return 1;
}

static int
hatch_points_near (const double left[3], const double right[3])
{
  double scale = 1.0;
  double tolerance;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      if (!isfinite (left[axis]) || !isfinite (right[axis]))
        return 0;
      scale = fmax (scale, fabs (left[axis]));
      scale = fmax (scale, fabs (right[axis]));
    }
  tolerance = fmax (1.0e-8, scale * DBL_EPSILON * 64.0);
  for (axis = 0; axis < 3; axis++)
    {
      if (fabs (left[axis] - right[axis]) > tolerance)
        return 0;
    }
  return 1;
}

static int
append_hatch_segment_run (HatchRing *ring,
                          const LineSegment *segments,
                          size_t count)
{
  const LineSegment *first;
  const LineSegment *last;
  int reverse = 0;
  size_t index;
  if (!ring || !ring->vertices || !segments || !count)
    return HATCH_RING_INVALID;
  first = &segments[0];
  last = &segments[count - 1u];
  if (!ring->vertex_count)
    {
      memcpy (ring->vertices[ring->vertex_count++], first->start,
              sizeof (first->start));
    }
  else if (hatch_points_near (
               ring->vertices[ring->vertex_count - 1u],
               first->start))
    reverse = 0;
  else if (hatch_points_near (
               ring->vertices[ring->vertex_count - 1u],
               last->end))
    reverse = 1;
  else
    return HATCH_RING_OPEN;

  if (reverse)
    {
      for (index = count; index > 0; index--)
        {
          const LineSegment *segment = &segments[index - 1u];
          double *current = ring->vertices[ring->vertex_count - 1u];
          if (!hatch_points_near (current, segment->end))
            return HATCH_RING_OPEN;
          if (!hatch_points_near (current, segment->start))
            {
              memcpy (ring->vertices[ring->vertex_count++],
                      segment->start, sizeof (segment->start));
            }
          if (segment->approximated_curve)
            ring->approximated_curve = 1;
        }
    }
  else
    {
      for (index = 0; index < count; index++)
        {
          const LineSegment *segment = &segments[index];
          double *current = ring->vertices[ring->vertex_count - 1u];
          if (!hatch_points_near (current, segment->start))
            return HATCH_RING_OPEN;
          if (!hatch_points_near (current, segment->end))
            {
              memcpy (ring->vertices[ring->vertex_count++],
                      segment->end, sizeof (segment->end));
            }
          if (segment->approximated_curve)
            ring->approximated_curve = 1;
        }
    }
  return HATCH_RING_VALID;
}

static int
hatch_projected_area (const HatchRing *ring, const double normal[3],
                      double *signed_area, double *extent)
{
  size_t dropped_axis;
  size_t first_axis;
  size_t second_axis;
  double origin[2];
  double twice_area = 0.0;
  double maximum_extent = 0.0;
  size_t index;
  if (!ring || !ring->vertices || ring->vertex_count < 3u
      || !normal || !signed_area || !extent)
    return 0;
  if (fabs (normal[0]) >= fabs (normal[1])
      && fabs (normal[0]) >= fabs (normal[2]))
    dropped_axis = 0;
  else if (fabs (normal[1]) >= fabs (normal[2]))
    dropped_axis = 1;
  else
    dropped_axis = 2;
  if (dropped_axis == 0)
    {
      first_axis = 1;
      second_axis = 2;
    }
  else if (dropped_axis == 1)
    {
      first_axis = 0;
      second_axis = 2;
    }
  else
    {
      first_axis = 0;
      second_axis = 1;
    }
  origin[0] = ring->vertices[0][first_axis];
  origin[1] = ring->vertices[0][second_axis];
  for (index = 0; index < ring->vertex_count; index++)
    {
      const double *left = ring->vertices[index];
      const double *right
          = ring->vertices[(index + 1u) % ring->vertex_count];
      double left_x = left[first_axis] - origin[0];
      double left_y = left[second_axis] - origin[1];
      double right_x = right[first_axis] - origin[0];
      double right_y = right[second_axis] - origin[1];
      if (!isfinite (left_x) || !isfinite (left_y)
          || !isfinite (right_x) || !isfinite (right_y))
        return 0;
      maximum_extent = fmax (maximum_extent, fabs (left_x));
      maximum_extent = fmax (maximum_extent, fabs (left_y));
      maximum_extent = fmax (maximum_extent, fabs (right_x));
      maximum_extent = fmax (maximum_extent, fabs (right_y));
      twice_area += left_x * right_y - right_x * left_y;
    }
  *signed_area = twice_area * 0.5;
  *extent = maximum_extent;
  return isfinite (*signed_area) && isfinite (*extent);
}

static void
free_hatch_ring (HatchRing *ring)
{
  if (!ring)
    return;
  free (ring->vertices);
  memset (ring, 0, sizeof (*ring));
}

static int
build_hatch_ring (CacheWriter *writer, const Dwg_Entity_HATCH *hatch,
                  const Dwg_HATCH_Path *path, uint64_t maximum_vertices,
                  HatchRing *ring)
{
  uint64_t requested;
  LineSegment *segments = NULL;
  HatchSegmentCollector collector;
  SegmentIteration iteration;
  LineSegment base;
  double normal[3];
  double extent;
  uint64_t generated;
  size_t item_count;
  size_t item_index;
  int status = HATCH_RING_INVALID;
  if (!writer || !hatch || !path || !ring)
    return HATCH_RING_INVALID;
  memset (ring, 0, sizeof (*ring));
  requested = hatch_path_requested_segments (path);
  if (requested < 3u)
    return HATCH_RING_INVALID;
  if (requested > maximum_vertices
      || requested > MAX_HATCH_BOUNDARY_SEGMENTS)
    return HATCH_RING_TRUNCATED;
  if (requested > SIZE_MAX - 1u)
    {
      set_error (writer, "HATCH ring exceeds platform limits");
      return HATCH_RING_ERROR;
    }
  segments = (LineSegment *)calloc ((size_t)requested,
                                    sizeof (LineSegment));
  ring->vertices = (double (*)[3])calloc (
      (size_t)requested + 1u, sizeof (*ring->vertices));
  if (!segments || !ring->vertices)
    {
      set_error (writer, "cannot allocate bounded HATCH ring");
      status = HATCH_RING_ERROR;
      goto done;
    }
  finite_normal_or_unit_z (
      hatch->extrusion.x, hatch->extrusion.y,
      hatch->extrusion.z, normal);
  memset (&collector, 0, sizeof (collector));
  collector.segments = segments;
  collector.capacity = (size_t)requested;
  memset (&iteration, 0, sizeof (iteration));
  iteration.consumer = collect_hatch_segment;
  iteration.consumer_context = &collector;
  memset (&base, 0, sizeof (base));

  item_count = (size_t)path->num_segs_or_paths;
  if ((path->flag & 2u) != 0u)
    {
      generated = 0;
      if (!iterate_hatch_polyline_path (
              path, hatch->elevation, normal, &base, &iteration,
              &generated))
        {
          set_error (writer, "cannot collect bounded HATCH polyline");
          status = HATCH_RING_ERROR;
          goto done;
        }
      if (iteration.skipped || collector.count != (size_t)requested)
        goto done;
      status = append_hatch_segment_run (
          ring, segments, collector.count);
      ring->source_edge_count = 1u;
      if (status != HATCH_RING_VALID)
        goto done;
    }
  else
    {
      ring->source_edge_count = (uint32_t)item_count;
      for (item_index = 0; item_index < item_count; item_index++)
        {
          size_t first_segment = collector.count;
          generated = 0;
          if (!iterate_hatch_edge (
                  &path->segs[item_index], hatch->elevation,
                  normal, &base, &iteration, &generated))
            {
              set_error (writer, "cannot collect bounded HATCH edge");
              status = HATCH_RING_ERROR;
              goto done;
            }
          if (collector.count == first_segment)
            goto done;
          status = append_hatch_segment_run (
              ring, &segments[first_segment],
              collector.count - first_segment);
          if (status != HATCH_RING_VALID)
            goto done;
        }
      if (iteration.skipped || collector.count != (size_t)requested)
        {
          status = HATCH_RING_INVALID;
          goto done;
        }
    }

  if (ring->vertex_count < 4u
      || !hatch_points_near (
          ring->vertices[0],
          ring->vertices[ring->vertex_count - 1u]))
    {
      status = HATCH_RING_OPEN;
      goto done;
    }
  ring->vertex_count--;
  if (ring->vertex_count < 3u
      || !hatch_projected_area (
          ring, normal, &ring->signed_area, &extent)
      || fabs (ring->signed_area)
             <= fmax (extent * extent * 1.0e-14, 1.0e-18))
    {
      status = HATCH_RING_INVALID;
      goto done;
    }
  status = HATCH_RING_VALID;

done:
  free (segments);
  if (status != HATCH_RING_VALID)
    free_hatch_ring (ring);
  return status;
}

static int
scan_hatch_paths (CacheWriter *writer, const Dwg_Object *object,
                  const Dwg_Entity_HATCH *hatch, uint64_t hatch_index,
                  uint64_t *global_vertices,
                  HatchRingConsumer consumer, void *consumer_context,
                  HatchEntityScan *scan)
{
  uint64_t hatch_vertices = 0;
  size_t path_count;
  size_t path_index;
  if (!writer || !hatch || !global_vertices || !scan)
    return 0;
  memset (scan, 0, sizeof (*scan));
  if (!hatch->paths || !hatch->num_paths)
    return 1;
  path_count = (size_t)hatch->num_paths;
  for (path_index = 0; path_index < path_count; path_index++)
    {
      const Dwg_HATCH_Path *path = &hatch->paths[path_index];
      HatchRing ring;
      uint64_t hatch_remaining
          = MAX_HATCH_BOUNDARY_SEGMENTS - hatch_vertices;
      uint64_t global_remaining
          = MAX_HATCH_FILL_VERTICES - *global_vertices;
      uint64_t maximum_vertices
          = hatch_remaining < global_remaining
                ? hatch_remaining
                : global_remaining;
      int status;
      if ((path->flag & 32u) != 0u
          || ((path->flag & 2u) != 0u && !path->closed))
        {
          scan->skipped_open_paths++;
          continue;
        }
      status = build_hatch_ring (
          writer, hatch, path, maximum_vertices, &ring);
      if (status == HATCH_RING_ERROR)
        return 0;
      if (status == HATCH_RING_TRUNCATED)
        {
          scan->truncated = 1;
          break;
        }
      if (status == HATCH_RING_OPEN)
        {
          scan->skipped_open_paths++;
          continue;
        }
      if (status == HATCH_RING_INVALID)
        {
          scan->skipped_invalid_paths++;
          continue;
        }
      if (path_index > UINT32_MAX
          || (consumer
              && !consumer (
                  consumer_context, object, hatch, hatch_index,
                  (uint32_t)path_index, path, &ring)))
        {
          free_hatch_ring (&ring);
          if (!writer->failed)
            set_error (writer, "cannot write bounded HATCH ring");
          return 0;
        }
      hatch_vertices += (uint64_t)ring.vertex_count;
      *global_vertices += (uint64_t)ring.vertex_count;
      scan->loops++;
      scan->vertices += (uint64_t)ring.vertex_count;
      free_hatch_ring (&ring);
    }
  return 1;
}

static uint64_t
scan_hatch_gradient_colors (const Dwg_Entity_HATCH *hatch,
                            uint64_t *global_count, int *truncated)
{
  uint64_t count = 0;
  size_t index;
  if (!hatch || !global_count || !truncated)
    return 0;
  if (hatch->num_colors > 0 && !hatch->colors)
    {
      *truncated = 1;
      return 0;
    }
  for (index = 0; hatch->colors
                  && index < (size_t)hatch->num_colors;
       index++)
    {
      if (*global_count >= MAX_HATCH_AUX_RECORDS
          || !isfinite (hatch->colors[index].shift_value))
        {
          *truncated = 1;
          continue;
        }
      (*global_count)++;
      count++;
    }
  return count;
}

static uint64_t
scan_hatch_seed_points (const Dwg_Entity_HATCH *hatch,
                        uint64_t *global_count, int *truncated)
{
  uint64_t count = 0;
  size_t index;
  if (!hatch || !global_count || !truncated)
    return 0;
  if (hatch->num_seeds > 0 && !hatch->seeds)
    {
      *truncated = 1;
      return 0;
    }
  for (index = 0; hatch->seeds
                  && index < (size_t)hatch->num_seeds;
       index++)
    {
      if (*global_count >= MAX_HATCH_AUX_RECORDS
          || !isfinite (hatch->seeds[index].x)
          || !isfinite (hatch->seeds[index].y))
        {
          *truncated = 1;
          continue;
        }
      (*global_count)++;
      count++;
    }
  return count;
}

static int
hatch_pattern_line_is_finite (const Dwg_HATCH_DefLine *line)
{
  size_t dash_index;
  if (!line || !isfinite (line->angle) || !isfinite (line->pt0.x)
      || !isfinite (line->pt0.y) || !isfinite (line->offset.x)
      || !isfinite (line->offset.y)
      || (line->num_dashes > 0u && !line->dashes))
    return 0;
  for (dash_index = 0; dash_index < (size_t)line->num_dashes;
       dash_index++)
    {
      if (!isfinite (line->dashes[dash_index]))
        return 0;
    }
  return 1;
}

static int
scan_hatch_pattern_lines (
    const Dwg_Entity_HATCH *hatch, uint64_t hatch_index,
    uint64_t *global_lines, uint64_t *global_dashes,
    HatchPatternLineConsumer consumer, void *consumer_context,
    HatchPatternScan *scan)
{
  size_t source_line_index;
  if (!hatch || !global_lines || !global_dashes || !scan)
    return 0;
  memset (scan, 0, sizeof (*scan));
  if (hatch->num_deflines > 0u && !hatch->deflines)
    {
      scan->truncated = 1;
      return 1;
    }
  for (source_line_index = 0;
       hatch->deflines
       && source_line_index < (size_t)hatch->num_deflines;
       source_line_index++)
    {
      const Dwg_HATCH_DefLine *line
          = &hatch->deflines[source_line_index];
      uint64_t dash_count = (uint64_t)line->num_dashes;
      uint64_t first_dash;
      if (!hatch_pattern_line_is_finite (line))
        {
          scan->invalid_lines++;
          continue;
        }
      if (scan->lines >= MAX_HATCH_PATTERN_LINES_PER_ENTITY
          || scan->dashes
                     > MAX_HATCH_PATTERN_DASHES_PER_ENTITY - dash_count
          || *global_lines >= MAX_HATCH_PATTERN_LINES
          || *global_dashes > MAX_HATCH_PATTERN_DASHES - dash_count)
        {
          scan->truncated = 1;
          break;
        }
      first_dash = *global_dashes;
      if (consumer
          && !consumer (
              consumer_context, hatch_index,
              (uint32_t)source_line_index, line, first_dash,
              (uint32_t)dash_count))
        return 0;
      (*global_lines)++;
      *global_dashes += dash_count;
      scan->lines++;
      scan->dashes += dash_count;
    }
  return 1;
}

static double
finite_or_default (double value, double fallback)
{
  return isfinite (value) ? value : fallback;
}

static int
copy_hatch_names (BITCODE_RS codepage, const Dwg_Entity_HATCH *hatch,
                  char **pattern_name, char **gradient_name)
{
  *pattern_name = copy_utf8_field (
      codepage,
      (void *)hatch, "HATCH", "name", "");
  *gradient_name = copy_utf8_field (
      codepage,
      (void *)hatch, "HATCH", "gradient_name", "");
  if (!*pattern_name || !*gradient_name)
    {
      free (*pattern_name);
      free (*gradient_name);
      *pattern_name = NULL;
      *gradient_name = NULL;
      return 0;
    }
  return 1;
}

static int
hatch_background_color (const Dwg_Data *dwg, const Dwg_Object *object,
                        uint32_t *encoded_color)
{
  const Dwg_Object_Entity *entity;
  size_t index;
  if (!encoded_color)
    return 0;
  *encoded_color = 0u;
  if (!dwg || !object || !(entity = object->tio.entity)
      || (entity->num_eed > 0u && !entity->eed))
    return 0;
  for (index = 0; index < (size_t)entity->num_eed; index++)
    {
      const Dwg_Eed *eed = &entity->eed[index];
      Dwg_Object *appid_object;
      Dwg_Object_APPID *appid;
      char *name;
      int matches;
      if (!eed->data || eed->data->code != 71u || !eed->handle.value)
        continue;
      appid_object = dwg_resolve_handle_silent (
          dwg, (BITCODE_HV)eed->handle.value);
      if (!appid_object || appid_object->fixedtype != DWG_TYPE_APPID
          || !appid_object->tio.object
          || !(appid = appid_object->tio.object->tio.APPID))
        continue;
      name = copy_utf8_field (
          dwg->header.codepage, appid, "APPID", "name", "");
      if (!name)
        return 0;
      matches = strcmp (name, "HATCHBACKGROUNDCOLOR") == 0;
      free (name);
      if (!matches)
        continue;
      *encoded_color
          = (3u << 30)
            | ((uint32_t)eed->data->u.eed_71.rl & 0x00ffffffu)
            | encode_transparency (&entity->color, 0);
      return 1;
    }
  return 0;
}

static int
write_hatch_entity_section (
    CacheWriter *writer, const Dwg_Data *dwg,
    const CacheTables *tables, const LibreDwgPrimitiveCounts *counts,
    LibreDwgHatchFillSummary *summary, SectionEntry *entry)
{
  uint64_t offset;
  uint64_t string_offset;
  uint64_t string_cursor = 0;
  uint64_t global_vertices = 0;
  uint64_t global_gradient_colors = 0;
  uint64_t global_seed_points = 0;
  uint64_t global_pattern_lines = 0;
  uint64_t global_pattern_dashes = 0;
  uint64_t first_loop = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  if (counts->hatches > UINT32_MAX
      || counts->hatches
             > (UINT64_MAX - STRING_TABLE_HEADER_SIZE)
                   / HATCH_ENTITY_RECORD_SIZE)
    {
      set_error (writer, "too many HATCH entities for scene cache");
      return 0;
    }
  string_offset
      = STRING_TABLE_HEADER_SIZE
        + counts->hatches * HATCH_ENTITY_RECORD_SIZE;
  memset (summary, 0, sizeof (*summary));
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)counts->hatches)
      || !write_u32 (writer, HATCH_ENTITY_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    return 0;

  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchEntityScan scan;
      HatchPatternScan pattern_scan;
      char *pattern_name = NULL;
      char *gradient_name = NULL;
      uint32_t pattern_offset;
      uint32_t pattern_length;
      uint32_t gradient_offset;
      uint32_t gradient_length;
      uint32_t flags = 0;
      uint32_t background_color = 0;
      uint64_t first_gradient_color = global_gradient_colors;
      uint64_t first_seed_point = global_seed_points;
      uint64_t gradient_color_count;
      uint64_t seed_point_count;
      double normal[3];
      int fill_truncated = 0;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_paths (
              writer, object, hatch, hatch_index, &global_vertices,
              NULL, NULL, &scan))
        return 0;
      gradient_color_count = scan_hatch_gradient_colors (
          hatch, &global_gradient_colors, &fill_truncated);
      seed_point_count = scan_hatch_seed_points (
          hatch, &global_seed_points, &fill_truncated);
      fill_truncated |= scan.truncated;
      if (!scan_hatch_pattern_lines (
              hatch, hatch_index, &global_pattern_lines,
              &global_pattern_dashes, NULL, NULL, &pattern_scan))
        return 0;
      if (!copy_hatch_names (
              dwg->header.codepage, hatch, &pattern_name, &gradient_name)
          || !checked_string_layout (
              &string_cursor, pattern_name, &pattern_offset,
              &pattern_length)
          || !checked_string_layout (
              &string_cursor, gradient_name, &gradient_offset,
              &gradient_length))
        {
          free (pattern_name);
          free (gradient_name);
          set_error (writer, "cannot prepare bounded HATCH strings");
          return 0;
        }
      finite_normal_or_unit_z (
          hatch->extrusion.x, hatch->extrusion.y,
          hatch->extrusion.z, normal);
      if (hatch->is_solid_fill)
        flags |= HATCH_FLAG_SOLID;
      if (hatch->is_associative)
        flags |= HATCH_FLAG_ASSOCIATIVE;
      if (hatch->double_flag)
        flags |= HATCH_FLAG_DOUBLE;
      if (hatch->is_gradient_fill)
        flags |= HATCH_FLAG_GRADIENT;
      if (hatch->single_color_gradient)
        flags |= HATCH_FLAG_SINGLE_COLOR_GRADIENT;
      if (fill_truncated || pattern_scan.truncated)
        flags |= HATCH_FLAG_TRUNCATED;
      if (hatch_background_color (dwg, object, &background_color))
        flags |= HATCH_FLAG_BACKGROUND_COLOR;

      if (!write_common (writer, object, tables)
          || !write_u32 (writer, pattern_offset)
          || !write_u32 (writer, pattern_length)
          || !write_u32 (writer, gradient_offset)
          || !write_u32 (writer, gradient_length)
          || !write_u32 (writer, flags)
          || !write_u16 (writer, (uint16_t)hatch->style)
          || !write_u16 (writer, (uint16_t)hatch->pattern_type)
          || !write_u64 (writer, first_loop)
          || !write_u64 (writer, scan.loops)
          || !write_u64 (writer, first_gradient_color)
          || !write_u64 (writer, gradient_color_count)
          || !write_f64 (
              writer, finite_or_default (hatch->elevation, 0.0))
          || !write_vec3 (writer, normal)
          || !write_f64 (
              writer, finite_or_default (hatch->angle, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->scale_spacing, 1.0))
          || !write_f64 (
              writer, finite_or_default (hatch->pixel_size, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->gradient_angle, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->gradient_shift, 0.0))
          || !write_f64 (
              writer,
              finite_or_default (hatch->gradient_tint, 0.0))
          || !write_u64 (writer, first_seed_point)
          || !write_u64 (writer, seed_point_count)
          || !write_u32 (writer, background_color)
          || !write_u32 (writer, (uint32_t)hatch->num_deflines))
        {
          free (pattern_name);
          free (gradient_name);
          return 0;
        }
      free (pattern_name);
      free (gradient_name);

      summary->source_hatches++;
      if (hatch->is_gradient_fill)
        summary->gradient_hatches++;
      else if (hatch->is_solid_fill)
        summary->solid_hatches++;
      else
        summary->pattern_hatches++;
      summary->fill_loops += scan.loops;
      summary->fill_vertices += scan.vertices;
      summary->gradient_colors += gradient_color_count;
      summary->seed_points += seed_point_count;
      summary->pattern_definition_lines += pattern_scan.lines;
      summary->pattern_dashes += pattern_scan.dashes;
      summary->skipped_open_paths += scan.skipped_open_paths;
      summary->skipped_invalid_paths += scan.skipped_invalid_paths;
      summary->skipped_invalid_pattern_lines
          += pattern_scan.invalid_lines;
      if (fill_truncated)
        summary->truncated_fill_hatches++;
      if (pattern_scan.truncated)
        summary->truncated_pattern_hatches++;
      first_loop += scan.loops;
      hatch_index++;
    }
  if (hatch_index != counts->hatches
      || first_loop != summary->fill_loops
      || global_vertices != summary->fill_vertices
      || global_pattern_lines != summary->pattern_definition_lines
      || global_pattern_dashes != summary->pattern_dashes)
    {
      set_error (writer, "HATCH entity counts changed while writing");
      return 0;
    }

  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      char *pattern_name = NULL;
      char *gradient_name = NULL;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!copy_hatch_names (
              dwg->header.codepage, hatch, &pattern_name, &gradient_name))
        {
          set_error (writer, "cannot copy bounded HATCH strings");
          return 0;
        }
      if (!write_bytes (
              writer, pattern_name, strlen (pattern_name))
          || !write_bytes (
              writer, gradient_name, strlen (gradient_name)))
        {
          free (pattern_name);
          free (gradient_name);
          return 0;
        }
      free (pattern_name);
      free (gradient_name);
    }
  return finish_variable_section (
      writer, entry, SECTION_HATCH_ENTITIES,
      HATCH_ENTITY_RECORD_SIZE, "hatch_entities", offset,
      counts->hatches, SECTION_FLAG_STRING_TABLE);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t first_vertex;
  uint64_t loops;
} HatchLoopWriter;

static int
write_hatch_loop (void *context, const Dwg_Object *object,
                  const Dwg_Entity_HATCH *hatch,
                  uint64_t hatch_index, uint32_t path_index,
                  const Dwg_HATCH_Path *path, const HatchRing *ring)
{
  HatchLoopWriter *writer = (HatchLoopWriter *)context;
  uint32_t flags
      = ring->approximated_curve
            ? HATCH_LOOP_FLAG_APPROXIMATED_CURVE
            : 0u;
  (void)object;
  (void)hatch;
  if (!write_u64 (writer->writer, hatch_index)
      || !write_u32 (writer->writer, (uint32_t)path->flag)
      || !write_u32 (writer->writer, path_index)
      || !write_u64 (writer->writer, writer->first_vertex)
      || !write_u64 (
          writer->writer, (uint64_t)ring->vertex_count)
      || !write_u32 (writer->writer, ring->source_edge_count)
      || !write_u32 (writer->writer, flags)
      || !write_f64 (writer->writer, ring->signed_area))
    return 0;
  writer->first_vertex += (uint64_t)ring->vertex_count;
  writer->loops++;
  return 1;
}

static int
write_hatch_loop_section (CacheWriter *writer, const Dwg_Data *dwg,
                          SectionEntry *entry)
{
  HatchLoopWriter loop_writer;
  uint64_t offset;
  uint64_t global_vertices = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&loop_writer, 0, sizeof (loop_writer));
  loop_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchEntityScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_paths (
              writer, object, hatch, hatch_index, &global_vertices,
              write_hatch_loop, &loop_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (loop_writer.first_vertex != global_vertices)
    {
      set_error (writer, "HATCH loop and vertex counts differ");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_LOOPS, HATCH_LOOP_RECORD_SIZE,
      "hatch_loops", offset, loop_writer.loops);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t vertices;
} HatchVertexWriter;

static int
write_hatch_vertices (void *context, const Dwg_Object *object,
                      const Dwg_Entity_HATCH *hatch,
                      uint64_t hatch_index, uint32_t path_index,
                      const Dwg_HATCH_Path *path,
                      const HatchRing *ring)
{
  HatchVertexWriter *writer = (HatchVertexWriter *)context;
  size_t index;
  (void)object;
  (void)hatch;
  (void)hatch_index;
  (void)path_index;
  (void)path;
  for (index = 0; index < ring->vertex_count; index++)
    {
      if (!write_vec3 (writer->writer, ring->vertices[index]))
        return 0;
      writer->vertices++;
    }
  return 1;
}

static int
write_hatch_vertex_section (CacheWriter *writer, const Dwg_Data *dwg,
                            SectionEntry *entry)
{
  HatchVertexWriter vertex_writer;
  uint64_t offset;
  uint64_t global_vertices = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&vertex_writer, 0, sizeof (vertex_writer));
  vertex_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchEntityScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_paths (
              writer, object, hatch, hatch_index, &global_vertices,
              write_hatch_vertices, &vertex_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (vertex_writer.vertices != global_vertices)
    {
      set_error (writer, "HATCH vertex pass changed record count");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_VERTICES,
      HATCH_VERTEX_RECORD_SIZE, "hatch_vertices", offset,
      vertex_writer.vertices);
}

static int
write_hatch_gradient_color_section (CacheWriter *writer,
                                    const Dwg_Data *dwg,
                                    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      size_t color_index;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH)
          || !hatch->colors)
        continue;
      for (color_index = 0;
           color_index < (size_t)hatch->num_colors;
           color_index++)
        {
          const Dwg_HATCH_Color *color = &hatch->colors[color_index];
          if (count >= MAX_HATCH_AUX_RECORDS
              || !isfinite (color->shift_value))
            continue;
          if (!write_f64 (writer, color->shift_value)
              || !write_u32 (writer, encode_color (&color->color))
              || !write_u32 (writer, 0))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_GRADIENT_COLORS,
      HATCH_GRADIENT_COLOR_RECORD_SIZE, "hatch_gradient_colors",
      offset, count);
}

static int
write_hatch_seed_point_section (CacheWriter *writer,
                                const Dwg_Data *dwg,
                                SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      size_t seed_index;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH)
          || !hatch->seeds)
        continue;
      for (seed_index = 0; seed_index < (size_t)hatch->num_seeds;
           seed_index++)
        {
          const BITCODE_2RD *seed = &hatch->seeds[seed_index];
          if (count >= MAX_HATCH_AUX_RECORDS
              || !isfinite (seed->x) || !isfinite (seed->y))
            continue;
          if (!write_f64 (writer, seed->x)
              || !write_f64 (writer, seed->y))
            return 0;
          count++;
        }
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_SEED_POINTS,
      HATCH_SEED_POINT_RECORD_SIZE, "hatch_seed_points", offset,
      count);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t lines;
} HatchPatternLineWriter;

static int
write_hatch_pattern_line (
    void *context, uint64_t hatch_index, uint32_t source_line_index,
    const Dwg_HATCH_DefLine *line, uint64_t first_dash,
    uint32_t dash_count)
{
  HatchPatternLineWriter *writer
      = (HatchPatternLineWriter *)context;
  if (!write_u64 (writer->writer, hatch_index)
      || !write_u32 (writer->writer, source_line_index)
      || !write_u32 (writer->writer, 0)
      || !write_f64 (writer->writer, line->angle)
      || !write_f64 (writer->writer, line->pt0.x)
      || !write_f64 (writer->writer, line->pt0.y)
      || !write_f64 (writer->writer, line->offset.x)
      || !write_f64 (writer->writer, line->offset.y)
      || !write_u64 (writer->writer, first_dash)
      || !write_u32 (writer->writer, dash_count)
      || !write_u32 (writer->writer, 0))
    return 0;
  writer->lines++;
  return 1;
}

static int
write_hatch_pattern_line_section (CacheWriter *writer,
                                  const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  HatchPatternLineWriter line_writer;
  uint64_t offset;
  uint64_t global_lines = 0;
  uint64_t global_dashes = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&line_writer, 0, sizeof (line_writer));
  line_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchPatternScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_pattern_lines (
              hatch, hatch_index, &global_lines, &global_dashes,
              write_hatch_pattern_line, &line_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (line_writer.lines != global_lines)
    {
      set_error (writer, "HATCH pattern-line pass changed record count");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_PATTERN_LINES,
      HATCH_PATTERN_LINE_RECORD_SIZE, "hatch_pattern_lines", offset,
      line_writer.lines);
}

typedef struct
{
  CacheWriter *writer;
  uint64_t dashes;
} HatchPatternDashWriter;

static int
write_hatch_pattern_dashes (
    void *context, uint64_t hatch_index, uint32_t source_line_index,
    const Dwg_HATCH_DefLine *line, uint64_t first_dash,
    uint32_t dash_count)
{
  HatchPatternDashWriter *writer
      = (HatchPatternDashWriter *)context;
  size_t dash_index;
  (void)hatch_index;
  (void)source_line_index;
  if (first_dash != writer->dashes)
    return 0;
  for (dash_index = 0; dash_index < (size_t)dash_count; dash_index++)
    {
      if (!write_f64 (writer->writer, line->dashes[dash_index]))
        return 0;
      writer->dashes++;
    }
  return 1;
}

static int
write_hatch_pattern_dash_section (CacheWriter *writer,
                                  const Dwg_Data *dwg,
                                  SectionEntry *entry)
{
  HatchPatternDashWriter dash_writer;
  uint64_t offset;
  uint64_t global_lines = 0;
  uint64_t global_dashes = 0;
  uint64_t hatch_index = 0;
  size_t object_index;
  memset (&dash_writer, 0, sizeof (dash_writer));
  dash_writer.writer = writer;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_HATCH *hatch;
      HatchPatternScan scan;
      if (object->fixedtype != DWG_TYPE_HATCH
          || !object->tio.entity
          || !(hatch = object->tio.entity->tio.HATCH))
        continue;
      if (!scan_hatch_pattern_lines (
              hatch, hatch_index, &global_lines, &global_dashes,
              write_hatch_pattern_dashes, &dash_writer, &scan))
        return 0;
      hatch_index++;
    }
  if (dash_writer.dashes != global_dashes)
    {
      set_error (writer, "HATCH pattern-dash pass changed record count");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_HATCH_PATTERN_DASHES,
      HATCH_PATTERN_DASH_RECORD_SIZE, "hatch_pattern_dashes", offset,
      dash_writer.dashes);
}

static int
write_point_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                            const CacheTables *tables,
                            SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_POINT *point;
      double location[3];
      double normal[3];
      if (object->fixedtype != DWG_TYPE_POINT || !object->tio.entity
          || !(point = object->tio.entity->tio.POINT))
        continue;
      location[0] = point->x;
      location[1] = point->y;
      location[2] = point->z;
      if (!isfinite (location[0]) || !isfinite (location[1])
          || !isfinite (location[2]) || !isfinite (point->thickness)
          || !isfinite (point->x_ang)
          || !isfinite (dwg->header_vars.PDSIZE))
        {
          set_error (writer, "POINT source contains a non-finite value");
          return 0;
        }
      finite_normal_or_unit_z (
          point->extrusion.x, point->extrusion.y, point->extrusion.z,
          normal);
      if (!write_common (writer, object, tables)
          || !write_vec3 (writer, location)
          || !write_vec3 (writer, normal)
          || !write_f64 (writer, point->thickness)
          || !write_f64 (writer, point->x_ang)
          || !write_f64 (writer, dwg->header_vars.PDSIZE)
          || !write_i16 (writer, (int16_t)dwg->header_vars.PDMODE)
          || !write_u16 (writer, 0) || !write_u32 (writer, 0))
        return 0;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_POINT_ENTITIES, POINT_ENTITY_RECORD_SIZE,
      "point_entities", offset, count);
}

static int
solid_triangle_is_usable (const double first[3], const double second[3],
                          const double third[3])
{
  double left[3];
  double right[3];
  double cross[3];
  double left_length;
  double right_length;
  double scale;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      left[axis] = second[axis] - first[axis];
      right[axis] = third[axis] - first[axis];
    }
  cross[0] = left[1] * right[2] - left[2] * right[1];
  cross[1] = left[2] * right[0] - left[0] * right[2];
  cross[2] = left[0] * right[1] - left[1] * right[0];
  left_length = hypot (hypot (left[0], left[1]), left[2]);
  right_length = hypot (hypot (right[0], right[1]), right[2]);
  scale = fmax (1.0, fmax (left_length, right_length));
  return hypot (hypot (cross[0], cross[1]), cross[2])
         > scale * scale * 1.0e-12;
}

static int
write_solid_surface_record (CacheWriter *writer,
                            const Dwg_Object *object,
                            const CacheTables *tables,
                            const Dwg_Color *display_color,
                            const double corners[4][3],
                            uint32_t fill_mode, uint64_t *count)
{
  static const double normal[3] = { 0.0, 0.0, 1.0 };
  size_t corner_index;
  size_t axis;
  if (!solid_triangle_is_usable (corners[0], corners[1], corners[2])
      && !solid_triangle_is_usable (
          corners[0], corners[2], corners[3]))
    return 1;
  if (*count >= MAX_SOLID_SOURCE_RECORDS)
    {
      set_error (writer, "SOLID/MLINE fill source exceeds its record limit");
      return 0;
    }
  for (corner_index = 0; corner_index < 4; corner_index++)
    for (axis = 0; axis < 3; axis++)
      if (!isfinite (corners[corner_index][axis]))
        {
          set_error (
              writer, "SOLID/MLINE fill source contains a non-finite corner");
          return 0;
        }
  if (!write_common_color (
          writer, object, tables, display_color)
      || !write_u32 (writer, fill_mode ? 1u : 0u)
      || !write_u32 (writer, 0))
    return 0;
  for (corner_index = 0; corner_index < 4; corner_index++)
    if (!write_vec3 (writer, corners[corner_index]))
      return 0;
  if (!write_vec3 (writer, normal) || !write_f64 (writer, 0.0))
    return 0;
  (*count)++;
  return 1;
}

static int
mline_outer_element_indices (const Dwg_Object_MLINESTYLE *style,
                             size_t line_count, size_t *first,
                             size_t *last)
{
  size_t index;
  if (!style || !style->lines || line_count < 2
      || line_count > (size_t)style->num_lines)
    return 0;
  *first = 0;
  *last = 0;
  for (index = 0; index < line_count; index++)
    {
      if (!isfinite (style->lines[index].offset))
        return 0;
      if (style->lines[index].offset
          > style->lines[*first].offset)
        *first = index;
      if (style->lines[index].offset
          < style->lines[*last].offset)
        *last = index;
    }
  return *first != *last;
}

static void
mline_fill_point (const double base[3], const double direction[3],
                  double distance, double point[3])
{
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    point[axis] = base[axis] + direction[axis] * distance;
}

static int
write_mline_fill_interval (CacheWriter *writer,
                           const Dwg_Object *object,
                           const CacheTables *tables,
                           const Dwg_Object_MLINESTYLE *style,
                           const double bases[2][3],
                           const double direction[3],
                           const double starts[2],
                           const double stops[2], uint64_t *count)
{
  double corners[4][3];
  if (stops[0] - starts[0] <= CURVE_EPSILON
      || stops[1] - starts[1] <= CURVE_EPSILON)
    return 1;
  mline_fill_point (bases[0], direction, starts[0], corners[0]);
  mline_fill_point (bases[0], direction, stops[0], corners[1]);
  mline_fill_point (bases[1], direction, stops[1], corners[2]);
  mline_fill_point (bases[1], direction, starts[1], corners[3]);
  return write_solid_surface_record (
      writer, object, tables, &style->fill_color, corners, 1u, count);
}

static int
write_mline_fill_segment (CacheWriter *writer,
                          const Dwg_Object *object,
                          const CacheTables *tables,
                          const Dwg_Entity_MLINE *mline,
                          const Dwg_Object_MLINESTYLE *style,
                          size_t vertex_index, size_t first_line,
                          size_t last_line, uint64_t *count)
{
  const size_t line_indices[2] = { first_line, last_line };
  const Dwg_MLINE_vertex *vertex = &mline->verts[vertex_index];
  const Dwg_MLINE_vertex *next
      = &mline->verts[(vertex_index + 1u) % (size_t)mline->num_verts];
  const Dwg_MLINE_line *lines[2];
  double bases[2][3];
  double ends[2][3];
  double direction[3];
  double lengths[2];
  double starts[2] = { 0.0, 0.0 };
  size_t parameter_count;
  size_t boundary;
  if (!normalize_mline_vector (vertex->vertex_direction, direction))
    return 0;
  for (boundary = 0; boundary < 2; boundary++)
    {
      size_t line_index = line_indices[boundary];
      if (!vertex->lines || !next->lines
          || line_index >= (size_t)vertex->num_lines
          || line_index >= (size_t)next->num_lines
          || !mline_element_intersection (
              vertex, line_index, bases[boundary])
          || !mline_element_intersection (
              next, line_index, ends[boundary]))
        return 0;
      lines[boundary] = &vertex->lines[line_index];
      lengths[boundary]
          = (ends[boundary][0] - bases[boundary][0]) * direction[0]
            + (ends[boundary][1] - bases[boundary][1]) * direction[1]
            + (ends[boundary][2] - bases[boundary][2]) * direction[2];
      if (!isfinite (lengths[boundary])
          || lengths[boundary] <= CURVE_EPSILON)
        return 0;
    }
  if (lines[0]->num_areafillparms
      != lines[1]->num_areafillparms)
    return 0;
  parameter_count = (size_t)lines[0]->num_areafillparms;
  if (parameter_count != 0u)
    return 0;
  return write_mline_fill_interval (
      writer, object, tables, style, bases, direction, starts,
      lengths, count);
}

static int
write_mline_round_fill_cap (CacheWriter *writer,
                            const Dwg_Object *object,
                            const CacheTables *tables,
                            const Dwg_Entity_MLINE *mline,
                            const Dwg_Object_MLINESTYLE *style,
                            size_t vertex_index, size_t first_line,
                            size_t last_line, int is_start,
                            uint64_t *count)
{
  const Dwg_MLINE_vertex *vertex = &mline->verts[vertex_index];
  double first[3];
  double last[3];
  double center[3];
  double across[3];
  double outward[3];
  double bulge[3];
  double previous[3];
  double radius;
  double projection;
  double bulge_length;
  size_t axis;
  size_t chord;
  const size_t chords = 12u;
  if (!(is_start
            ? mline_element_start (vertex, first_line, first)
            : mline_element_intersection (vertex, first_line, first))
      || !(is_start
               ? mline_element_start (vertex, last_line, last)
               : mline_element_intersection (vertex, last_line, last))
      || !normalize_mline_vector (vertex->vertex_direction, outward))
    return 0;
  if (is_start)
    for (axis = 0; axis < 3; axis++)
      outward[axis] = -outward[axis];
  for (axis = 0; axis < 3; axis++)
    {
      center[axis] = (first[axis] + last[axis]) * 0.5;
      across[axis] = first[axis] - center[axis];
    }
  radius = hypot (hypot (across[0], across[1]), across[2]);
  if (!isfinite (radius) || radius <= CURVE_EPSILON)
    return 1;
  for (axis = 0; axis < 3; axis++)
    across[axis] /= radius;
  projection = outward[0] * across[0] + outward[1] * across[1]
               + outward[2] * across[2];
  for (axis = 0; axis < 3; axis++)
    bulge[axis] = outward[axis] - across[axis] * projection;
  bulge_length = hypot (hypot (bulge[0], bulge[1]), bulge[2]);
  if (!isfinite (bulge_length) || bulge_length <= CURVE_EPSILON)
    return 0;
  for (axis = 0; axis < 3; axis++)
    {
      bulge[axis] /= bulge_length;
      previous[axis] = first[axis];
    }
  for (chord = 1; chord <= chords; chord++)
    {
      double angle = acos (-1.0) * (double)chord / (double)chords;
      double point[3];
      double triangle[4][3];
      for (axis = 0; axis < 3; axis++)
        {
          point[axis]
              = center[axis]
                + radius
                      * (across[axis] * cos (angle)
                         + bulge[axis] * sin (angle));
          triangle[0][axis] = center[axis];
          triangle[1][axis] = previous[axis];
          triangle[2][axis] = point[axis];
          triangle[3][axis] = point[axis];
        }
      if (!write_solid_surface_record (
              writer, object, tables, &style->fill_color,
              triangle, 1u, count))
        return 0;
      memcpy (previous, point, sizeof (previous));
    }
  return 1;
}

static int
write_mline_fill_records (CacheWriter *writer,
                          const Dwg_Object *object,
                          const CacheTables *tables, uint64_t *count)
{
  const Dwg_Entity_MLINE *mline;
  const Dwg_Object_MLINESTYLE *style;
  size_t vertex_count;
  size_t line_count;
  size_t segment_count;
  size_t first_line;
  size_t last_line;
  size_t vertex_index;
  if (!object || object->fixedtype != DWG_TYPE_MLINE
      || !object->tio.entity
      || !(mline = object->tio.entity->tio.MLINE))
    return 1;
  style = resolve_mline_style (object, mline);
  if (!style || ((uint32_t)style->flag & 1u) == 0u)
    return 1;
  if (mline->num_verts < 2 || !mline->verts || mline->num_lines < 2)
    {
      set_error (writer, "filled MLINE source is incomplete");
      return 0;
    }
  vertex_count = (size_t)mline->num_verts;
  line_count = (size_t)mline->num_lines;
  if (line_count > (size_t)style->num_lines)
    line_count = (size_t)style->num_lines;
  if (!mline_outer_element_indices (
          style, line_count, &first_line, &last_line))
    {
      set_error (writer, "filled MLINE style has no usable outer elements");
      return 0;
    }
  segment_count
      = ((uint32_t)mline->flags & 2u) != 0u
            ? vertex_count
            : vertex_count - 1u;
  for (vertex_index = 0; vertex_index < segment_count; vertex_index++)
    if (!write_mline_fill_segment (
            writer, object, tables, mline, style, vertex_index,
            first_line, last_line, count))
      {
        set_error (
            writer, "MLINE area-fill boundary is unsupported or incomplete");
        return 0;
      }
  if (((uint32_t)mline->flags & 2u) == 0u)
    {
      if (((uint32_t)mline->flags & 4u) == 0u
          && ((uint32_t)style->flag & 64u) != 0u
          && !write_mline_round_fill_cap (
              writer, object, tables, mline, style, 0u,
              first_line, last_line, 1, count))
        return 0;
      if (((uint32_t)mline->flags & 8u) == 0u
          && ((uint32_t)style->flag & 1024u) != 0u
          && !write_mline_round_fill_cap (
              writer, object, tables, mline, style,
              vertex_count - 1u, first_line, last_line, 0, count))
        return 0;
    }
  return 1;
}

static int
write_solid_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                            const CacheTables *tables,
                            SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_SOLID *solid = NULL;
      const Dwg_Entity_TRACE *trace = NULL;
      double corners[4][3];
      double normal[3];
      double elevation;
      double thickness;
      size_t corner_index;
      if (!object->tio.entity)
        continue;
      if (object->fixedtype == DWG_TYPE_MLINE)
        {
          if (dwg->header_vars.FILLMODE
              && !write_mline_fill_records (
                  writer, object, tables, &count))
            return 0;
          continue;
        }
      if (object->fixedtype == DWG_TYPE_SOLID
          && (solid = object->tio.entity->tio.SOLID))
        {
          corners[0][0] = solid->corner1.x;
          corners[0][1] = solid->corner1.y;
          corners[1][0] = solid->corner2.x;
          corners[1][1] = solid->corner2.y;
          /*
           * AutoCAD records the third SOLID corner opposite corner 2 and the
           * fourth opposite corner 1.  Cache the quadrilateral in perimeter
           * order so every consumer can triangulate, outline and hit-test it
           * as 1-2-4-3.  A triangular SOLID remains 1-2-3-3 because corners
           * 3 and 4 are identical in that case. TRACE uses the same ordering.
           */
          corners[2][0] = solid->corner4.x;
          corners[2][1] = solid->corner4.y;
          corners[3][0] = solid->corner3.x;
          corners[3][1] = solid->corner3.y;
          elevation = solid->elevation;
          thickness = solid->thickness;
          finite_normal_or_unit_z (
              solid->extrusion.x, solid->extrusion.y,
              solid->extrusion.z, normal);
        }
      else if (object->fixedtype == DWG_TYPE_TRACE
               && (trace = object->tio.entity->tio.TRACE))
        {
          corners[0][0] = trace->corner1.x;
          corners[0][1] = trace->corner1.y;
          corners[1][0] = trace->corner2.x;
          corners[1][1] = trace->corner2.y;
          corners[2][0] = trace->corner4.x;
          corners[2][1] = trace->corner4.y;
          corners[3][0] = trace->corner3.x;
          corners[3][1] = trace->corner3.y;
          elevation = trace->elevation;
          thickness = trace->thickness;
          finite_normal_or_unit_z (
              trace->extrusion.x, trace->extrusion.y,
              trace->extrusion.z, normal);
        }
      else
        continue;
      for (corner_index = 0; corner_index < 4; corner_index++)
        corners[corner_index][2] = elevation;
      if (!isfinite (elevation) || !isfinite (thickness))
        {
          set_error (
              writer, "SOLID/TRACE source contains a non-finite value");
          return 0;
        }
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          if (!isfinite (corners[corner_index][0])
              || !isfinite (corners[corner_index][1]))
            {
              set_error (
                  writer,
                  "SOLID/TRACE source contains a non-finite corner");
              return 0;
            }
        }
      if (count >= MAX_SOLID_SOURCE_RECORDS)
        {
          set_error (writer, "SOLID/MLINE fill source exceeds its record limit");
          return 0;
        }
      if (!write_common (writer, object, tables)
          || !write_u32 (writer, dwg->header_vars.FILLMODE ? 1u : 0u)
          || !write_u32 (writer, 0))
        return 0;
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          if (!write_vec3 (writer, corners[corner_index]))
            return 0;
        }
      if (!write_vec3 (writer, normal)
          || !write_f64 (writer, thickness))
        return 0;
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_SOLID_ENTITIES, SOLID_ENTITY_RECORD_SIZE,
      "solid_entities", offset, count);
}

static int
write_face_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                           const CacheTables *tables,
                           SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity__3DFACE *face;
      const BITCODE_3BD *corners[4];
      size_t corner_index;
      if (object->fixedtype != DWG_TYPE__3DFACE || !object->tio.entity
          || !(face = object->tio.entity->tio._3DFACE))
        continue;
      if (((uint32_t)face->invis_flags & ~15u) != 0)
        {
          set_error (
              writer,
              "3DFACE source contains unsupported invisible-edge flags");
          return 0;
        }
      corners[0] = &face->corner1;
      corners[1] = &face->corner2;
      corners[2] = &face->corner3;
      corners[3] = &face->corner4;
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          if (!isfinite (corners[corner_index]->x)
              || !isfinite (corners[corner_index]->y)
              || !isfinite (corners[corner_index]->z))
            {
              set_error (
                  writer, "3DFACE source contains a non-finite corner");
              return 0;
            }
        }
      if (!write_common (writer, object, tables)
          || !write_u32 (writer, (uint32_t)face->invis_flags)
          || !write_u32 (writer, 0))
        return 0;
      for (corner_index = 0; corner_index < 4; corner_index++)
        {
          const double corner[3]
              = { corners[corner_index]->x, corners[corner_index]->y,
                  corners[corner_index]->z };
          if (!write_vec3 (writer, corner))
            return 0;
        }
      count++;
    }
  return finish_fixed_section (
      writer, entry, SECTION_FACE_ENTITIES, FACE_ENTITY_RECORD_SIZE,
      "face_entities", offset, count);
}

static int
validate_wipeout_source (CacheWriter *writer,
                         const Dwg_Entity_WIPEOUT *wipeout)
{
  double cross_x;
  double cross_y;
  double cross_z;
  double basis_length_squared;
  uint32_t vertex_index;
  if ((uint32_t)wipeout->class_version > INT32_MAX)
    {
      set_error (writer, "WIPEOUT class version exceeds cache limits");
      return 0;
    }
  if (((uint32_t)wipeout->display_props & ~15u) != 0)
    {
      set_error (
          writer,
          "WIPEOUT source contains unsupported display properties");
      return 0;
    }
  if ((uint32_t)wipeout->clipping > 1u
      || (uint32_t)wipeout->clip_mode > 1u
      || (uint32_t)wipeout->brightness > 100u
      || (uint32_t)wipeout->contrast > 100u
      || (uint32_t)wipeout->fade > 100u)
    {
      set_error (writer, "WIPEOUT source contains invalid image metadata");
      return 0;
    }
  if (((uint32_t)wipeout->clip_boundary_type == 1u
       && (uint32_t)wipeout->num_clip_verts != 2u)
      || ((uint32_t)wipeout->clip_boundary_type == 2u
          && (uint32_t)wipeout->num_clip_verts < 3u)
      || ((uint32_t)wipeout->clip_boundary_type != 1u
          && (uint32_t)wipeout->clip_boundary_type != 2u))
    {
      set_error (writer, "WIPEOUT source contains an invalid clip boundary");
      return 0;
    }
  if ((uint32_t)wipeout->num_clip_verts > MAX_WIPEOUT_CLIP_VERTICES
      || (wipeout->num_clip_verts && !wipeout->clip_verts))
    {
      set_error (writer, "WIPEOUT clip boundary exceeds cache limits");
      return 0;
    }
  if (!isfinite (wipeout->pt0.x) || !isfinite (wipeout->pt0.y)
      || !isfinite (wipeout->pt0.z) || !isfinite (wipeout->uvec.x)
      || !isfinite (wipeout->uvec.y) || !isfinite (wipeout->uvec.z)
      || !isfinite (wipeout->vvec.x) || !isfinite (wipeout->vvec.y)
      || !isfinite (wipeout->vvec.z)
      || !isfinite (wipeout->image_size.x)
      || !isfinite (wipeout->image_size.y)
      || wipeout->image_size.x <= 0.0 || wipeout->image_size.y <= 0.0)
    {
      set_error (
          writer,
          "WIPEOUT source contains a non-finite or invalid coordinate");
      return 0;
    }
  for (vertex_index = 0;
       vertex_index < (uint32_t)wipeout->num_clip_verts; vertex_index++)
    {
      if (!isfinite (wipeout->clip_verts[vertex_index].x)
          || !isfinite (wipeout->clip_verts[vertex_index].y))
        {
          set_error (
              writer,
              "WIPEOUT source contains a non-finite clip coordinate");
          return 0;
        }
    }
  cross_x = wipeout->uvec.y * wipeout->vvec.z
            - wipeout->uvec.z * wipeout->vvec.y;
  cross_y = wipeout->uvec.z * wipeout->vvec.x
            - wipeout->uvec.x * wipeout->vvec.z;
  cross_z = wipeout->uvec.x * wipeout->vvec.y
            - wipeout->uvec.y * wipeout->vvec.x;
  basis_length_squared
      = cross_x * cross_x + cross_y * cross_y + cross_z * cross_z;
  if (!isfinite (basis_length_squared)
      || basis_length_squared <= 1.0e-24)
    {
      set_error (writer, "WIPEOUT source contains a degenerate image basis");
      return 0;
    }
  return 1;
}

static int
write_wipeout_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                              const CacheTables *tables,
                              SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  uint64_t first_clip_vertex = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_WIPEOUT *wipeout;
      uint32_t clip_vertex_count;
      double insertion_point[3];
      double u_vector[3];
      double v_vector[3];
      if (object->fixedtype != DWG_TYPE_WIPEOUT || !object->tio.entity
          || !(wipeout = object->tio.entity->tio.WIPEOUT))
        continue;
      if (!validate_wipeout_source (writer, wipeout))
        return 0;
      count++;
      if (count > MAX_WIPEOUT_SOURCE_RECORDS)
        {
          set_error (writer, "WIPEOUT source exceeds its entity limit");
          return 0;
        }
      clip_vertex_count = (uint32_t)wipeout->num_clip_verts;
      if (first_clip_vertex
          > (uint64_t)MAX_WIPEOUT_CLIP_VERTICES - clip_vertex_count)
        {
          set_error (
              writer,
              "WIPEOUT source exceeds its clip-vertex limit");
          return 0;
        }
      insertion_point[0] = wipeout->pt0.x;
      insertion_point[1] = wipeout->pt0.y;
      insertion_point[2] = wipeout->pt0.z;
      u_vector[0] = wipeout->uvec.x;
      u_vector[1] = wipeout->uvec.y;
      u_vector[2] = wipeout->uvec.z;
      v_vector[0] = wipeout->vvec.x;
      v_vector[1] = wipeout->vvec.y;
      v_vector[2] = wipeout->vvec.z;
      if (!write_common (writer, object, tables)
          || !write_i32 (writer, (int32_t)wipeout->class_version)
          || !write_u16 (writer, (uint16_t)wipeout->display_props)
          || !write_u8 (
              writer, (uint8_t)wipeout->clip_boundary_type)
          || !write_u8 (writer, (uint8_t)wipeout->clipping)
          || !write_u8 (writer, (uint8_t)wipeout->brightness)
          || !write_u8 (writer, (uint8_t)wipeout->contrast)
          || !write_u8 (writer, (uint8_t)wipeout->fade)
          || !write_u8 (writer, (uint8_t)wipeout->clip_mode)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, first_clip_vertex)
          || !write_u32 (writer, clip_vertex_count)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, reference_handle (wipeout->imagedef))
          || !write_u64 (
              writer, reference_handle (wipeout->imagedefreactor))
          || !write_vec3 (writer, insertion_point)
          || !write_vec3 (writer, u_vector)
          || !write_vec3 (writer, v_vector)
          || !write_f64 (writer, wipeout->image_size.x)
          || !write_f64 (writer, wipeout->image_size.y))
        return 0;
      first_clip_vertex += clip_vertex_count;
    }
  return finish_fixed_section (
      writer, entry, SECTION_WIPEOUT_ENTITIES,
      WIPEOUT_ENTITY_RECORD_SIZE, "wipeout_entities", offset, count);
}

static int
write_wipeout_clip_vertex_section (CacheWriter *writer,
                                   const Dwg_Data *dwg,
                                   SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_WIPEOUT *wipeout;
      uint32_t vertex_index;
      if (object->fixedtype != DWG_TYPE_WIPEOUT || !object->tio.entity
          || !(wipeout = object->tio.entity->tio.WIPEOUT))
        continue;
      if (!validate_wipeout_source (writer, wipeout))
        return 0;
      if (count > (uint64_t)MAX_WIPEOUT_CLIP_VERTICES
                      - (uint32_t)wipeout->num_clip_verts)
        {
          set_error (
              writer,
              "WIPEOUT source exceeds its clip-vertex limit");
          return 0;
        }
      for (vertex_index = 0;
           vertex_index < (uint32_t)wipeout->num_clip_verts;
           vertex_index++)
        {
          if (!write_f64 (writer, wipeout->clip_verts[vertex_index].x)
              || !write_f64 (
                  writer, wipeout->clip_verts[vertex_index].y))
            return 0;
        }
      count += (uint32_t)wipeout->num_clip_verts;
    }
  return finish_fixed_section (
      writer, entry, SECTION_WIPEOUT_CLIP_VERTICES,
      WIPEOUT_CLIP_VERTEX_RECORD_SIZE, "wipeout_clip_vertices", offset,
      count);
}

static Dwg_Object_IMAGEDEF *
image_definition (const Dwg_Data *dwg, const Dwg_Entity_IMAGE *image)
{
  Dwg_Object *object;
  if (!image)
    return NULL;
  object = reference_object (dwg, image->imagedef);
  if (!object || object->fixedtype != DWG_TYPE_IMAGEDEF
      || !object->tio.object || !object->tio.object->tio.IMAGEDEF)
    return NULL;
  return object->tio.object->tio.IMAGEDEF;
}

static char *
copy_image_path (const Dwg_Data *dwg, const Dwg_Entity_IMAGE *image)
{
  Dwg_Object_IMAGEDEF *definition = image_definition (dwg, image);
  if (!definition)
    return copy_valid_utf8 ("");
  return copy_utf8_field (
      dwg->header.codepage, definition, "IMAGEDEF", "file_path", "");
}

static int
validate_image_source (CacheWriter *writer,
                       const Dwg_Entity_IMAGE *image)
{
  double cross_x;
  double cross_y;
  double cross_z;
  double basis_length_squared;
  uint32_t clip_vertex_count;
  uint32_t vertex_index;
  if ((uint32_t)image->class_version > INT32_MAX)
    {
      set_error (writer, "IMAGE class version exceeds cache limits");
      return 0;
    }
  if (((uint32_t)image->display_props & ~15u) != 0)
    {
      set_error (
          writer, "IMAGE source contains unsupported display properties");
      return 0;
    }
  if ((uint32_t)image->clipping > 1u
      || (uint32_t)image->clip_mode > 1u
      || (uint32_t)image->brightness > 100u
      || (uint32_t)image->contrast > 100u
      || (uint32_t)image->fade > 100u)
    {
      set_error (writer, "IMAGE source contains invalid display metadata");
      return 0;
    }
  clip_vertex_count = (uint32_t)image->num_clip_verts;
  if (clip_vertex_count > MAX_IMAGE_CLIP_VERTICES
      || (clip_vertex_count && !image->clip_verts))
    {
      set_error (writer, "IMAGE clip boundary exceeds cache limits");
      return 0;
    }
  if (clip_vertex_count
      && (((uint32_t)image->clip_boundary_type == 1u
           && clip_vertex_count != 2u)
          || ((uint32_t)image->clip_boundary_type == 2u
              && clip_vertex_count < 3u)
          || ((uint32_t)image->clip_boundary_type != 1u
              && (uint32_t)image->clip_boundary_type != 2u)))
    {
      set_error (writer, "IMAGE source contains an invalid clip boundary");
      return 0;
    }
  if (image->clipping && (image->display_props & 4u)
      && clip_vertex_count == 0)
    {
      set_error (writer, "IMAGE clipping is enabled without a boundary");
      return 0;
    }
  if (!isfinite (image->pt0.x) || !isfinite (image->pt0.y)
      || !isfinite (image->pt0.z) || !isfinite (image->uvec.x)
      || !isfinite (image->uvec.y) || !isfinite (image->uvec.z)
      || !isfinite (image->vvec.x) || !isfinite (image->vvec.y)
      || !isfinite (image->vvec.z)
      || !isfinite (image->image_size.x)
      || !isfinite (image->image_size.y)
      || image->image_size.x <= 0.0 || image->image_size.y <= 0.0)
    {
      set_error (
          writer, "IMAGE source contains a non-finite or invalid coordinate");
      return 0;
    }
  for (vertex_index = 0; vertex_index < clip_vertex_count;
       vertex_index++)
    {
      if (!isfinite (image->clip_verts[vertex_index].x)
          || !isfinite (image->clip_verts[vertex_index].y))
        {
          set_error (
              writer, "IMAGE source contains a non-finite clip coordinate");
          return 0;
        }
    }
  cross_x = image->uvec.y * image->vvec.z
            - image->uvec.z * image->vvec.y;
  cross_y = image->uvec.z * image->vvec.x
            - image->uvec.x * image->vvec.z;
  cross_z = image->uvec.x * image->vvec.y
            - image->uvec.y * image->vvec.x;
  basis_length_squared
      = cross_x * cross_x + cross_y * cross_y + cross_z * cross_z;
  if (!isfinite (basis_length_squared)
      || basis_length_squared <= 1.0e-24)
    {
      set_error (writer, "IMAGE source contains a degenerate image basis");
      return 0;
    }
  return 1;
}

static int
write_image_entity_section (CacheWriter *writer, const Dwg_Data *dwg,
                            const CacheTables *tables,
                            const EmbeddedImageTable *embedded_images,
                            SectionEntry *entry)
{
  uint64_t image_count = 0;
  uint64_t string_cursor = 0;
  uint64_t string_offset;
  uint64_t offset;
  uint64_t first_clip_vertex = 0;
  uint32_t *references = NULL;
  char **paths = NULL;
  uint64_t row = 0;
  size_t object_index;
  int success = 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      if (object->fixedtype == DWG_TYPE_IMAGE && object->tio.entity
          && object->tio.entity->tio.IMAGE)
        image_count++;
    }
  if (embedded_images)
    {
      if (image_count != embedded_images->source_image_count
          || embedded_images->count > UINT64_MAX - image_count)
        {
          set_error (writer, "embedded IMAGE source count is inconsistent");
          return 0;
        }
      image_count += embedded_images->count;
    }
  if (image_count > MAX_IMAGE_SOURCE_RECORDS
      || image_count > UINT32_MAX
      || image_count > SIZE_MAX / sizeof (char *)
      || image_count > SIZE_MAX / (2 * sizeof (uint32_t)))
    {
      set_error (writer, "IMAGE source exceeds its entity limit");
      return 0;
    }
  if (image_count)
    {
      paths = (char **)calloc ((size_t)image_count, sizeof (char *));
      references = (uint32_t *)malloc (
          (size_t)image_count * 2 * sizeof (uint32_t));
      if (!paths || !references)
        {
          set_error (writer, "cannot allocate bounded IMAGE paths");
          goto done;
        }
    }
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_IMAGE *image;
      if (object->fixedtype != DWG_TYPE_IMAGE || !object->tio.entity
          || !(image = object->tio.entity->tio.IMAGE))
        continue;
      if (!validate_image_source (writer, image))
        goto done;
      paths[row] = copy_image_path (dwg, image);
      if (!paths[row]
          || !checked_string_layout (
              &string_cursor, paths[row], &references[row * 2],
              &references[row * 2 + 1]))
        {
          set_error (writer, "IMAGE path table exceeds its limits");
          goto done;
        }
      row++;
    }
  if (embedded_images)
    for (object_index = 0; object_index < embedded_images->count;
         object_index++)
      {
        const EmbeddedImagePreview *preview
            = &embedded_images->items[object_index];
        char path[80];
        int path_length = snprintf (
            path, sizeof (path), "@embedded/ole-%" PRIx64 ".%s",
            (uint64_t)preview->object->handle.value,
            preview->mime_type == EMBEDDED_IMAGE_MIME_EMF ? "emf"
                                                          : "bmp");
        if (path_length <= 0 || (size_t)path_length >= sizeof (path))
          {
            set_error (writer, "embedded IMAGE path exceeds its limits");
            goto done;
          }
        paths[row] = (char *)malloc ((size_t)path_length + 1u);
        if (!paths[row])
          {
            set_error (writer, "cannot allocate embedded IMAGE path");
            goto done;
          }
        memcpy (paths[row], path, (size_t)path_length + 1u);
        if (!checked_string_layout (
                &string_cursor, paths[row], &references[row * 2],
                &references[row * 2 + 1]))
          {
            set_error (writer, "embedded IMAGE path table exceeds its limits");
            goto done;
          }
        row++;
      }
  string_offset
      = STRING_TABLE_HEADER_SIZE + image_count * IMAGE_ENTITY_RECORD_SIZE;
  if (!align_writer (writer, &offset)
      || !write_u32 (writer, (uint32_t)image_count)
      || !write_u32 (writer, IMAGE_ENTITY_RECORD_SIZE)
      || !write_u64 (writer, string_offset))
    goto done;
  row = 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_IMAGE *image;
      uint32_t clip_vertex_count;
      double insertion_point[3];
      double u_vector[3];
      double v_vector[3];
      if (object->fixedtype != DWG_TYPE_IMAGE || !object->tio.entity
          || !(image = object->tio.entity->tio.IMAGE))
        continue;
      clip_vertex_count = (uint32_t)image->num_clip_verts;
      if (first_clip_vertex
          > (uint64_t)MAX_IMAGE_CLIP_VERTICES - clip_vertex_count)
        {
          set_error (writer, "IMAGE source exceeds its clip-vertex limit");
          goto done;
        }
      insertion_point[0] = image->pt0.x;
      insertion_point[1] = image->pt0.y;
      insertion_point[2] = image->pt0.z;
      u_vector[0] = image->uvec.x;
      u_vector[1] = image->uvec.y;
      u_vector[2] = image->uvec.z;
      v_vector[0] = image->vvec.x;
      v_vector[1] = image->vvec.y;
      v_vector[2] = image->vvec.z;
      if (!write_common (writer, object, tables)
          || !write_u32 (writer, references[row * 2])
          || !write_u32 (writer, references[row * 2 + 1])
          || !write_i32 (writer, (int32_t)image->class_version)
          || !write_u16 (writer, (uint16_t)image->display_props)
          || !write_u8 (
              writer, (uint8_t)image->clip_boundary_type)
          || !write_u8 (writer, (uint8_t)image->clipping)
          || !write_u8 (writer, (uint8_t)image->brightness)
          || !write_u8 (writer, (uint8_t)image->contrast)
          || !write_u8 (writer, (uint8_t)image->fade)
          || !write_u8 (writer, (uint8_t)image->clip_mode)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, first_clip_vertex)
          || !write_u32 (writer, clip_vertex_count)
          || !write_u32 (writer, 0)
          || !write_u64 (writer, reference_handle (image->imagedef))
          || !write_u64 (
              writer, reference_handle (image->imagedefreactor))
          || !write_vec3 (writer, insertion_point)
          || !write_vec3 (writer, u_vector)
          || !write_vec3 (writer, v_vector)
          || !write_f64 (writer, image->image_size.x)
          || !write_f64 (writer, image->image_size.y))
        goto done;
      first_clip_vertex += clip_vertex_count;
      row++;
    }
  if (embedded_images)
    for (object_index = 0; object_index < embedded_images->count;
         object_index++)
      {
        const EmbeddedImagePreview *preview
            = &embedded_images->items[object_index];
        const Dwg_Entity_OLE2FRAME *frame
            = preview->object->tio.entity->tio.OLE2FRAME;
        double points[4][3];
        double insertion_point[3];
        double u_vector[3];
        double v_vector[3];
        double width = preview->width ? (double)preview->width : 1.0;
        double height = preview->height ? (double)preview->height : 1.0;
        size_t axis;
        if (!ole2frame_corners (frame, points))
          {
            set_error (writer, "embedded IMAGE placement became invalid");
            goto done;
          }
        for (axis = 0; axis < 3; axis++)
          {
            u_vector[axis] = (points[1][axis] - points[0][axis]) / width;
            v_vector[axis] = (points[0][axis] - points[3][axis]) / height;
            insertion_point[axis]
                = points[3][axis] + 0.5 * u_vector[axis]
                  + 0.5 * v_vector[axis];
          }
        if (!write_common (writer, preview->object, tables)
            || !write_u32 (writer, references[row * 2])
            || !write_u32 (writer, references[row * 2 + 1])
            || !write_i32 (writer, 0) || !write_u16 (writer, 3u)
            || !write_u8 (writer, 0u) || !write_u8 (writer, 0u)
            || !write_u8 (writer, 50u) || !write_u8 (writer, 50u)
            || !write_u8 (writer, 0u) || !write_u8 (writer, 0u)
            || !write_u32 (writer, 0u)
            || !write_u64 (writer, first_clip_vertex)
            || !write_u32 (writer, 0u) || !write_u32 (writer, 0u)
            || !write_u64 (writer, 0u) || !write_u64 (writer, 0u)
            || !write_vec3 (writer, insertion_point)
            || !write_vec3 (writer, u_vector)
            || !write_vec3 (writer, v_vector)
            || !write_f64 (writer, width) || !write_f64 (writer, height))
          goto done;
        row++;
      }
  for (row = 0; row < image_count; row++)
    if (!write_bytes (writer, paths[row], strlen (paths[row])))
      goto done;
  success = finish_variable_section (
      writer, entry, SECTION_IMAGE_ENTITIES, IMAGE_ENTITY_RECORD_SIZE,
      "image_entities", offset, image_count, SECTION_FLAG_STRING_TABLE);

done:
  if (paths)
    for (row = 0; row < image_count; row++)
      free (paths[row]);
  free (paths);
  free (references);
  return success;
}

static int
write_image_clip_vertex_section (CacheWriter *writer,
                                 const Dwg_Data *dwg,
                                 SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t object_index;
  if (!align_writer (writer, &offset))
    return 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Entity_IMAGE *image;
      uint32_t vertex_index;
      if (object->fixedtype != DWG_TYPE_IMAGE || !object->tio.entity
          || !(image = object->tio.entity->tio.IMAGE))
        continue;
      if (!validate_image_source (writer, image))
        return 0;
      if (count > (uint64_t)MAX_IMAGE_CLIP_VERTICES
                      - (uint32_t)image->num_clip_verts)
        {
          set_error (writer, "IMAGE source exceeds its clip-vertex limit");
          return 0;
        }
      for (vertex_index = 0;
           vertex_index < (uint32_t)image->num_clip_verts;
           vertex_index++)
        {
          if (!write_f64 (writer, image->clip_verts[vertex_index].x)
              || !write_f64 (
                  writer, image->clip_verts[vertex_index].y))
            return 0;
        }
      count += (uint32_t)image->num_clip_verts;
    }
  return finish_fixed_section (
      writer, entry, SECTION_IMAGE_CLIP_VERTICES,
      IMAGE_CLIP_VERTEX_RECORD_SIZE, "image_clip_vertices", offset,
      count);
}

static int
write_embedded_image_record_section (
    CacheWriter *writer, const EmbeddedImageTable *table,
    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t count = 0;
  size_t index;
  if (!align_writer (writer, &offset))
    return 0;
  for (index = 0; index < table->count; index++)
    {
      const EmbeddedImagePreview *preview = &table->items[index];
      uint64_t image_index = table->source_image_count + index;
      if (!preview->payload_length)
        continue;
      if (image_index > UINT32_MAX
          || !write_u32 (writer, (uint32_t)image_index)
          || !write_u32 (writer, preview->mime_type)
          || !write_u64 (writer, preview->payload_offset)
          || !write_u64 (writer, preview->payload_length)
          || !write_u32 (writer, preview->width)
          || !write_u32 (writer, preview->height)
          || !write_u32 (writer, preview->flags)
          || !write_u32 (writer, 0u))
        return 0;
      count++;
    }
  if (count != table->available_count)
    {
      set_error (writer, "embedded IMAGE record count is inconsistent");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_EMBEDDED_IMAGE_RECORDS,
      EMBEDDED_IMAGE_RECORD_SIZE, "embedded_image_records", offset,
      count);
}

static int
write_embedded_image_byte_section (
    CacheWriter *writer, const EmbeddedImageTable *table,
    SectionEntry *entry)
{
  uint64_t offset;
  uint64_t cursor = 0;
  size_t index;
  if (!align_writer (writer, &offset))
    return 0;
  for (index = 0; index < table->count; index++)
    {
      const EmbeddedImagePreview *preview = &table->items[index];
      if (!preview->payload_length)
        continue;
      if (preview->payload_offset != cursor)
        {
          set_error (writer, "embedded IMAGE byte ranges are inconsistent");
          return 0;
        }
      if (preview->owned_payload)
        {
          if (preview->mime_type != EMBEDDED_IMAGE_MIME_EMF
              || !write_bytes (
                  writer, preview->owned_payload,
                  (size_t)preview->payload_length))
            return 0;
        }
      else if (preview->bmp)
        {
          if (preview->mime_type != EMBEDDED_IMAGE_MIME_BMP
              || preview->bmp_length != preview->payload_length
              || !write_bytes (
                  writer, preview->bmp, preview->bmp_length))
            return 0;
        }
      else
        {
          uint32_t file_size;
          uint32_t pixel_offset;
          if (preview->mime_type != EMBEDDED_IMAGE_MIME_BMP
              || !preview->bmi || !preview->bits
              || preview->bmi_length > UINT32_MAX - 14u
              || preview->bits_length
                     > UINT32_MAX - 14u - preview->bmi_length)
            {
              set_error (writer, "embedded IMAGE DIB range is invalid");
              return 0;
            }
          pixel_offset = 14u + preview->bmi_length;
          file_size = pixel_offset + preview->bits_length;
          if (file_size != preview->payload_length
              || !write_u16 (writer, 0x4d42u)
              || !write_u32 (writer, file_size)
              || !write_u32 (writer, 0u)
              || !write_u32 (writer, pixel_offset)
              || !write_bytes (
                  writer, preview->bmi, preview->bmi_length)
              || !write_bytes (
                  writer, preview->bits, preview->bits_length))
            return 0;
        }
      cursor += preview->payload_length;
    }
  if (cursor != table->byte_length)
    {
      set_error (writer, "embedded IMAGE byte count is inconsistent");
      return 0;
    }
  return finish_fixed_section (
      writer, entry, SECTION_EMBEDDED_IMAGE_BYTES,
      EMBEDDED_IMAGE_BYTE_RECORD_SIZE, "embedded_image_bytes", offset,
      cursor);
}

static int
draw_order_table_compare (const void *left, const void *right)
{
  const DrawOrderTableSource *a = (const DrawOrderTableSource *)left;
  const DrawOrderTableSource *b = (const DrawOrderTableSource *)right;
  if (a->owner_handle != b->owner_handle)
    return a->owner_handle < b->owner_handle ? -1 : 1;
  if (a->table_handle != b->table_handle)
    return a->table_handle < b->table_handle ? -1 : 1;
  return 0;
}

static int
draw_order_entry_compare (const void *left, const void *right)
{
  const DrawOrderEntrySource *a = (const DrawOrderEntrySource *)left;
  const DrawOrderEntrySource *b = (const DrawOrderEntrySource *)right;
  if (a->entity_handle != b->entity_handle)
    return a->entity_handle < b->entity_handle ? -1 : 1;
  if (a->sort_handle != b->sort_handle)
    return a->sort_handle < b->sort_handle ? -1 : 1;
  return 0;
}

static int
collect_draw_order_tables (CacheWriter *writer, const Dwg_Data *dwg,
                           DrawOrderTableSource **result,
                           size_t *result_count,
                           uint64_t *result_entry_count)
{
  DrawOrderTableSource *sources;
  size_t count = 0;
  size_t index = 0;
  size_t object_index;
  uint64_t total_entries = 0;
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      if (object->fixedtype == DWG_TYPE_SORTENTSTABLE
          && object->tio.object
          && object->tio.object->tio.SORTENTSTABLE)
        count++;
    }
  if (count > MAX_DRAW_ORDER_TABLES)
    {
      set_error (writer, "draw-order source exceeds its table limit");
      return 0;
    }
  sources
      = count ? (DrawOrderTableSource *)calloc (
                    count, sizeof (DrawOrderTableSource))
              : NULL;
  if (count && !sources)
    {
      set_error (writer, "cannot allocate bounded draw-order tables");
      return 0;
    }
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Object *object = &dwg->object[object_index];
      const Dwg_Object_SORTENTSTABLE *table;
      uint64_t entry_count;
      if (object->fixedtype != DWG_TYPE_SORTENTSTABLE
          || !object->tio.object
          || !(table = object->tio.object->tio.SORTENTSTABLE))
        continue;
      entry_count = (uint32_t)table->num_ents;
      if (entry_count > MAX_DRAW_ORDER_ENTRIES
          || total_entries > MAX_DRAW_ORDER_ENTRIES - entry_count
          || (entry_count && (!table->ents || !table->sort_ents)))
        {
          free (sources);
          set_error (writer, "draw-order source exceeds its entry limit");
          return 0;
        }
      sources[index].object = object;
      sources[index].table = table;
      sources[index].table_handle = (uint64_t)object->handle.value;
      sources[index].owner_handle
          = reference_handle (table->block_owner);
      sources[index].entry_count = (uint32_t)entry_count;
      total_entries += entry_count;
      index++;
    }
  if (count > 1)
    qsort (sources, count, sizeof (DrawOrderTableSource),
           draw_order_table_compare);
  *result = sources;
  *result_count = count;
  *result_entry_count = total_entries;
  return 1;
}

static int
write_draw_order_table_section (CacheWriter *writer,
                                const Dwg_Data *dwg,
                                SectionEntry *entry)
{
  DrawOrderTableSource *sources = NULL;
  size_t source_count = 0;
  uint64_t total_entries = 0;
  uint64_t first_entry = 0;
  uint64_t offset;
  size_t index;
  int success = 0;
  if (!collect_draw_order_tables (
          writer, dwg, &sources, &source_count, &total_entries)
      || !align_writer (writer, &offset))
    goto done;
  for (index = 0; index < source_count; index++)
    {
      const DrawOrderTableSource *source = &sources[index];
      if (!write_u64 (writer, source->table_handle)
          || !write_u64 (writer, source->owner_handle)
          || !write_u64 (writer, first_entry)
          || !write_u64 (writer, source->entry_count)
          || !write_u32 (writer, 0) || !write_u32 (writer, 0))
        goto done;
      first_entry += source->entry_count;
    }
  if (first_entry != total_entries)
    {
      set_error (writer, "draw-order table ranges are inconsistent");
      goto done;
    }
  success = finish_fixed_section (
      writer, entry, SECTION_DRAW_ORDER_TABLES,
      DRAW_ORDER_TABLE_RECORD_SIZE, "draw_order_tables", offset,
      source_count);

done:
  free (sources);
  return success;
}

static int
write_draw_order_entry_section (CacheWriter *writer,
                                const Dwg_Data *dwg,
                                SectionEntry *entry)
{
  DrawOrderTableSource *sources = NULL;
  DrawOrderEntrySource *entries = NULL;
  size_t source_count = 0;
  uint64_t total_entries = 0;
  uint64_t count = 0;
  uint64_t offset;
  size_t source_index;
  int success = 0;
  if (!collect_draw_order_tables (
          writer, dwg, &sources, &source_count, &total_entries)
      || !align_writer (writer, &offset))
    goto done;
  for (source_index = 0; source_index < source_count; source_index++)
    {
      const DrawOrderTableSource *source = &sources[source_index];
      uint32_t entry_index;
      entries
          = source->entry_count
                ? (DrawOrderEntrySource *)malloc (
                      source->entry_count * sizeof (DrawOrderEntrySource))
                : NULL;
      if (source->entry_count && !entries)
        {
          set_error (writer, "cannot allocate bounded draw-order entries");
          goto done;
        }
      for (entry_index = 0; entry_index < source->entry_count;
           entry_index++)
        {
          entries[entry_index].entity_handle
              = reference_handle (source->table->ents[entry_index]);
          entries[entry_index].sort_handle
              = reference_handle (source->table->sort_ents[entry_index]);
        }
      if (source->entry_count > 1)
        qsort (entries, source->entry_count,
               sizeof (DrawOrderEntrySource), draw_order_entry_compare);
      for (entry_index = 0; entry_index < source->entry_count;
           entry_index++)
        {
          if (!write_u64 (writer, entries[entry_index].entity_handle)
              || !write_u64 (writer, entries[entry_index].sort_handle))
            goto done;
          count++;
        }
      free (entries);
      entries = NULL;
    }
  if (count != total_entries)
    {
      set_error (writer, "draw-order entry count is inconsistent");
      goto done;
    }
  success = finish_fixed_section (
      writer, entry, SECTION_DRAW_ORDER_ENTRIES,
      DRAW_ORDER_ENTRY_RECORD_SIZE, "draw_order_entries", offset, count);

done:
  free (entries);
  free (sources);
  return success;
}

static int
count_gpu_segments (const Dwg_Data *dwg, const CacheTables *tables,
                    LibreDwgGpuLineSummary *summary,
                    OverviewPlan *overview)
{
  GpuSegmentCounter counter;
  uint64_t skipped = 0;
  uint64_t approximated = 0;
  size_t i;
  counter.summary = summary;
  counter.overview = overview;
  if (!iterate_gpu_segments (dwg, tables, NULL, count_gpu_segment,
                             &counter, NULL, &skipped, &approximated))
    return 0;
  summary->skipped_non_finite_segments = skipped;
  summary->approximated_curve_segments = approximated;
  for (i = 0; i < (size_t)dwg->num_objects; i++)
    {
      const Dwg_Object *object = &dwg->object[i];
      if (object->fixedtype == DWG_TYPE_HATCH
          && object->tio.entity
          && object->tio.entity->tio.HATCH
          && hatch_requested_boundary_segments (
                 object->tio.entity->tio.HATCH)
                 > MAX_HATCH_BOUNDARY_SEGMENTS)
        summary->truncated_hatch_entities++;
    }
  return 1;
}

typedef struct
{
  CacheWriter *writer;
  OverviewPlan *overview;
  FILE *file;
  SpatialSegmentRecord *buffers;
  SpatialSortRun *runs;
  size_t batch_counts[MAX_CONVERSION_WORKERS];
  size_t buffered;
  size_t batch_count;
  size_t run_count;
  size_t run_capacity;
  uint64_t records_written;
  uint64_t records_scheduled;
  uint64_t source_order;
  uint64_t sort_nanoseconds;
  uint64_t write_nanoseconds;
  uint32_t worker_count;
  uint32_t parallel_sort_workers;
} SpatialSortBuilder;

static FILE *
open_spatial_temp_file_with_access (CacheWriter *writer,
                                    int random_access)
{
#if defined(_WIN32)
  wchar_t temporary_directory[MAX_PATH + 1u];
  wchar_t temporary_path[MAX_PATH + 1u];
  DWORD directory_length;
  HANDLE handle;
  int descriptor;
  FILE *file;
  directory_length = GetTempPathW (
      (DWORD)(sizeof (temporary_directory)
              / sizeof (temporary_directory[0])),
      temporary_directory);
  if (!directory_length || directory_length > MAX_PATH
      || !GetTempFileNameW (
          temporary_directory, L"DWG", 0, temporary_path))
    {
      set_error (writer, "cannot create private spatial-sort storage");
      return NULL;
    }
  handle = CreateFileW (
      temporary_path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
      CREATE_ALWAYS,
      FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE
          | (random_access ? FILE_FLAG_RANDOM_ACCESS
                           : FILE_FLAG_SEQUENTIAL_SCAN),
      NULL);
  if (handle == INVALID_HANDLE_VALUE)
    {
      (void)DeleteFileW (temporary_path);
      set_error (writer, "cannot secure private spatial-sort storage");
      return NULL;
    }
  descriptor = _open_osfhandle (
      (intptr_t)handle, _O_RDWR | _O_BINARY | _O_NOINHERIT);
  if (descriptor < 0)
    {
      (void)CloseHandle (handle);
      (void)DeleteFileW (temporary_path);
      set_error (writer, "cannot secure private spatial-sort storage");
      return NULL;
    }
  file = _fdopen (descriptor, "w+b");
  if (!file)
    {
      (void)_close (descriptor);
      set_error (writer, "cannot open private spatial-sort storage");
      return NULL;
    }
  return file;
#else
  FILE *file = tmpfile ();
  int descriptor;
  int flags;
  (void)random_access;
  if (!file)
    {
      set_error (writer, "cannot create private spatial-sort storage");
      return NULL;
    }
  descriptor = fileno (file);
  flags = descriptor >= 0 ? fcntl (descriptor, F_GETFD) : -1;
  if (descriptor < 0 || fchmod (descriptor, 0600) != 0 || flags < 0
      || fcntl (descriptor, F_SETFD, flags | FD_CLOEXEC) != 0)
    {
      fclose (file);
      set_error (writer, "cannot secure private spatial-sort storage");
      return NULL;
    }
  return file;
#endif
}

static FILE *
open_spatial_temp_file (CacheWriter *writer)
{
  return open_spatial_temp_file_with_access (writer, 0);
}

static FILE *
open_spatial_run_file (CacheWriter *writer)
{
  return open_spatial_temp_file_with_access (writer, 1);
}

static void
close_spatial_segment_store (SpatialSegmentStore *store)
{
  if (store->file)
    fclose (store->file);
  free (store->runs);
  memset (store, 0, sizeof (*store));
}

static uint16_t
quantize_morton_axis (double value, double minimum, double maximum)
{
  double span = maximum - minimum;
  double normalized;
  if (!isfinite (span) || span <= 0.0)
    return 0;
  normalized = (value - minimum) / span;
  if (normalized < 0.0)
    normalized = 0.0;
  else if (normalized > 1.0)
    normalized = 1.0;
  return (uint16_t)round (normalized * (double)UINT16_MAX);
}

static uint32_t
interleave_u16 (uint16_t input)
{
  uint32_t value = input;
  value = (value | (value << 8)) & 0x00ff00ffu;
  value = (value | (value << 4)) & 0x0f0f0f0fu;
  value = (value | (value << 2)) & 0x33333333u;
  return (value | (value << 1)) & 0x55555555u;
}

static uint32_t
spatial_morton_key (const LineSegment *segment,
                    const OverviewPlan *overview)
{
  size_t index = overview_group_index (segment, overview);
  const OverviewGroup *group = &overview->groups[index];
  double midpoint_x
      = segment->start[0] * 0.5 + segment->end[0] * 0.5;
  double midpoint_y
      = segment->start[1] * 0.5 + segment->end[1] * 0.5;
  uint16_t x = quantize_morton_axis (
      midpoint_x, group->midpoint_min[0], group->midpoint_max[0]);
  uint16_t y = quantize_morton_axis (
      midpoint_y, group->midpoint_min[1], group->midpoint_max[1]);
  return interleave_u16 (x) | (interleave_u16 (y) << 1);
}

static int
spatial_record_compare (const void *left, const void *right)
{
  const SpatialSegmentRecord *a = (const SpatialSegmentRecord *)left;
  const SpatialSegmentRecord *b = (const SpatialSegmentRecord *)right;
  uint32_t a_group = a->segment.group;
  uint32_t b_group = b->segment.group;
  if (a_group != b_group)
    {
      if (a_group == UINT32_MAX)
        return -1;
      if (b_group == UINT32_MAX)
        return 1;
      return a_group < b_group ? -1 : 1;
    }
  if (a->morton != b->morton)
    return a->morton < b->morton ? -1 : 1;
  if (a->source_order != b->source_order)
    return a->source_order < b->source_order ? -1 : 1;
  return 0;
}

typedef struct
{
  SpatialSegmentRecord *records;
  size_t count;
} SpatialSortTask;

static void
sort_spatial_task (SpatialSortTask *task)
{
  qsort (task->records, task->count, sizeof (SpatialSegmentRecord),
         spatial_record_compare);
}

#if defined(_WIN32)
static unsigned __stdcall
sort_spatial_thread (void *context)
{
  sort_spatial_task ((SpatialSortTask *)context);
  return 0;
}
#elif !defined(__EMSCRIPTEN__)
static void *
sort_spatial_thread (void *context)
{
  sort_spatial_task ((SpatialSortTask *)context);
  return NULL;
}
#endif

static void
sort_spatial_tasks (SpatialSortBuilder *builder,
                    SpatialSortTask *tasks, size_t count)
{
  size_t launched = 0;
  size_t index;
  if (count <= 1 || builder->worker_count <= 1)
    {
      for (index = 0; index < count; index++)
        sort_spatial_task (&tasks[index]);
      if (count && builder->parallel_sort_workers < 1)
        builder->parallel_sort_workers = 1;
      return;
    }
#if defined(_WIN32)
  {
    HANDLE threads[MAX_CONVERSION_WORKERS - 1u];
    for (index = 0; index + 1u < count; index++)
      {
        uintptr_t thread = _beginthreadex (
            NULL, 0, sort_spatial_thread, &tasks[index], 0, NULL);
        if (!thread)
          break;
        threads[launched++] = (HANDLE)thread;
      }
    for (index = launched; index < count; index++)
      sort_spatial_task (&tasks[index]);
    for (index = 0; index < launched; index++)
      {
        (void)WaitForSingleObject (threads[index], INFINITE);
        (void)CloseHandle (threads[index]);
      }
  }
#elif defined(__EMSCRIPTEN__)
  for (index = 0; index < count; index++)
    sort_spatial_task (&tasks[index]);
#else
  {
    pthread_t threads[MAX_CONVERSION_WORKERS - 1u];
    for (index = 0; index + 1u < count; index++)
      {
        if (pthread_create (&threads[launched], NULL,
                            sort_spatial_thread, &tasks[index])
            != 0)
          break;
        launched++;
      }
    for (index = launched; index < count; index++)
      sort_spatial_task (&tasks[index]);
    for (index = 0; index < launched; index++)
      (void)pthread_join (threads[index], NULL);
  }
#endif
  if (builder->parallel_sort_workers < launched + 1u)
    builder->parallel_sort_workers = (uint32_t)(launched + 1u);
}

static int
flush_spatial_sort_batch (SpatialSortBuilder *builder)
{
  SpatialSortTask tasks[MAX_CONVERSION_WORKERS];
  uint64_t started;
  size_t index;
  if (!builder->batch_count)
    return 1;
  for (index = 0; index < builder->batch_count; index++)
    {
      tasks[index].records
          = builder->buffers + index * SPATIAL_SORT_RUN_SEGMENTS;
      tasks[index].count = builder->batch_counts[index];
    }
  started = monotonic_nanoseconds ();
  sort_spatial_tasks (builder, tasks, builder->batch_count);
  builder->sort_nanoseconds += elapsed_nanoseconds (started);
  started = monotonic_nanoseconds ();
  for (index = 0; index < builder->batch_count; index++)
    {
      if (fwrite (tasks[index].records, sizeof (SpatialSegmentRecord),
                  tasks[index].count, builder->file)
          != tasks[index].count)
        {
          set_error (builder->writer, "cannot write spatial-sort run");
          return 0;
        }
      builder->records_written += tasks[index].count;
    }
  builder->write_nanoseconds += elapsed_nanoseconds (started);
  builder->batch_count = 0;
  return 1;
}

static int
queue_spatial_sort_run (SpatialSortBuilder *builder)
{
  SpatialSortRun *run;
  if (!builder->buffered)
    return 1;
  if (builder->run_count >= builder->run_capacity
      || builder->batch_count >= builder->worker_count
      || UINT64_MAX - builder->records_scheduled < builder->buffered)
    {
      set_error (builder->writer, "spatial-sort run count is inconsistent");
      return 0;
    }
  run = &builder->runs[builder->run_count++];
  run->start = builder->records_scheduled;
  run->count = builder->buffered;
  builder->records_scheduled += builder->buffered;
  builder->batch_counts[builder->batch_count++] = builder->buffered;
  builder->buffered = 0;
  return builder->batch_count < builder->worker_count
         || flush_spatial_sort_batch (builder);
}

static int
spatial_sort_consume (void *context, const LineSegment *segment)
{
  SpatialSortBuilder *builder = (SpatialSortBuilder *)context;
  SpatialSegmentRecord *record;
  size_t index = overview_group_index (segment, builder->overview);
  if (index >= builder->overview->group_count
      || !builder->overview->groups[index].has_midpoint_bounds)
    {
      set_error (builder->writer, "spatial-sort group bounds are missing");
      return 0;
    }
  if (builder->buffered == SPATIAL_SORT_RUN_SEGMENTS
      && !queue_spatial_sort_run (builder))
    return 0;
  record = &builder->buffers[
      builder->batch_count * SPATIAL_SORT_RUN_SEGMENTS
      + builder->buffered++];
  record->segment = *segment;
  record->source_order = builder->source_order++;
  record->morton = spatial_morton_key (segment, builder->overview);
  record->reserved = 0;
  return 1;
}

static int
read_spatial_records (int descriptor, uint64_t index, size_t count,
                      SpatialSegmentRecord *records)
{
  uint64_t record_size = sizeof (SpatialSegmentRecord);
  uint64_t byte_offset;
  size_t byte_count;
  size_t completed = 0;
  if (index > (uint64_t)INT64_MAX / record_size
      || count > SIZE_MAX / sizeof (SpatialSegmentRecord))
    return 0;
  byte_offset = index * record_size;
  byte_count = count * sizeof (SpatialSegmentRecord);
#if defined(_WIN32)
  if (_lseeki64 (descriptor, (__int64)byte_offset, SEEK_SET) < 0)
    return 0;
#endif
  while (completed < byte_count)
    {
#if defined(_WIN32)
      size_t remaining = byte_count - completed;
      unsigned int requested
          = remaining > (size_t)INT_MAX ? (unsigned int)INT_MAX
                                        : (unsigned int)remaining;
      int result = _read (
          descriptor, (uint8_t *)records + completed, requested);
#else
      ssize_t result = pread (
          descriptor, (uint8_t *)records + completed,
          byte_count - completed, (off_t)(byte_offset + completed));
#endif
      if (result < 0 && errno == EINTR)
        continue;
      if (result <= 0)
        return 0;
      completed += (size_t)result;
    }
  return 1;
}

static int
load_spatial_merge_run (CacheWriter *writer, int descriptor,
                        SpatialMergeRun *run)
{
  size_t count
      = run->remaining < SPATIAL_MERGE_BUFFER_RECORDS
            ? (size_t)run->remaining
            : SPATIAL_MERGE_BUFFER_RECORDS;
  if (!count || !read_spatial_records (
                    descriptor, run->next, count, run->buffer))
    {
      set_error (writer, "cannot read spatial-sort run");
      return 0;
    }
  run->next += count;
  run->remaining -= count;
  run->buffered = count;
  run->position = 0;
  return 1;
}

static int
spatial_heap_less (const SpatialMergeRun *runs, size_t left,
                   size_t right)
{
  const SpatialSegmentRecord *a
      = &runs[left].buffer[runs[left].position];
  const SpatialSegmentRecord *b
      = &runs[right].buffer[runs[right].position];
  return spatial_record_compare (a, b) < 0;
}

static void
sift_spatial_heap (size_t *heap, size_t count, size_t root,
                   const SpatialMergeRun *runs)
{
  for (;;)
    {
      size_t left = root * 2u + 1u;
      size_t right = left + 1u;
      size_t smallest = root;
      size_t temporary;
      if (left < count
          && spatial_heap_less (runs, heap[left], heap[smallest]))
        smallest = left;
      if (right < count
          && spatial_heap_less (runs, heap[right], heap[smallest]))
        smallest = right;
      if (smallest == root)
        return;
      temporary = heap[root];
      heap[root] = heap[smallest];
      heap[smallest] = temporary;
      root = smallest;
    }
}

static int
merge_spatial_sort_runs (CacheWriter *writer, FILE *input,
                         const SpatialSortRun *source_runs,
                         size_t run_count, LineSegmentConsumer consumer,
                         void *consumer_context,
                         uint64_t expected)
{
  SpatialMergeRun *runs = NULL;
  size_t *heap = NULL;
  size_t heap_count = run_count;
  uint64_t emitted = 0;
  int descriptor = fileno (input);
  size_t i;
  int success = 0;
  if (descriptor < 0 || !source_runs || !run_count || !consumer)
    {
      set_error (writer, "spatial-sort runs are unavailable");
      return 0;
    }
  if (run_count > SIZE_MAX / sizeof (SpatialMergeRun)
      || run_count > SIZE_MAX / sizeof (size_t))
    {
      set_error (writer, "spatial-sort merge is too large");
      return 0;
    }
  runs = (SpatialMergeRun *)calloc (run_count, sizeof (*runs));
  heap = (size_t *)malloc (run_count * sizeof (*heap));
  if (!runs || !heap)
    {
      set_error (writer, "out of memory while merging spatial-sort runs");
      goto done;
    }
  for (i = 0; i < run_count; i++)
    {
      runs[i].next = source_runs[i].start;
      runs[i].remaining = source_runs[i].count;
      heap[i] = i;
      if (!load_spatial_merge_run (writer, descriptor, &runs[i]))
        goto done;
    }
  for (i = heap_count / 2u; i > 0; i--)
    sift_spatial_heap (heap, heap_count, i - 1u, runs);

  while (heap_count)
    {
      size_t run_index = heap[0];
      SpatialMergeRun *run = &runs[run_index];
      if (!consumer (consumer_context,
                     &run->buffer[run->position].segment))
        goto done;
      emitted++;
      run->position++;
      if (run->position == run->buffered)
        {
          if (run->remaining)
            {
              if (!load_spatial_merge_run (writer, descriptor, run))
                goto done;
            }
          else
            {
              heap[0] = heap[--heap_count];
            }
        }
      if (heap_count)
        sift_spatial_heap (heap, heap_count, 0, runs);
    }
  if (emitted != expected)
    {
      set_error (writer, "merged spatial geometry is incomplete");
      goto done;
    }
  success = 1;

done:
  free (heap);
  free (runs);
  return success;
}

static int
build_spatial_segment_store (CacheWriter *writer, const Dwg_Data *dwg,
                             const CacheTables *tables,
                             OverviewPlan *overview, uint64_t total,
                             SpatialSegmentStore *store,
                             LibreDwgSceneCachePerformance *performance)
{
  SpatialSortBuilder builder;
  FILE *runs_file = NULL;
  uint64_t selected = 0;
  uint64_t run_capacity
      = total / SPATIAL_SORT_RUN_SEGMENTS
        + (total % SPATIAL_SORT_RUN_SEGMENTS != 0);
  uint64_t collect_started = 0;
  uint64_t collect_total = 0;
  int success = 0;
  memset (&builder, 0, sizeof (builder));
  memset (store, 0, sizeof (*store));
  if (!total || total > (uint64_t)INT64_MAX
                            / sizeof (SpatialSegmentRecord)
      || run_capacity > SIZE_MAX
      || run_capacity > SIZE_MAX / sizeof (SpatialSortRun))
    {
      set_error (writer, "spatial-sort geometry is too large");
      return 0;
    }
  runs_file = open_spatial_run_file (writer);
  if (!runs_file)
    goto done;
  builder.worker_count = performance->worker_count;
  if (!builder.worker_count
      || builder.worker_count > MAX_CONVERSION_WORKERS)
    builder.worker_count = 1;
  builder.buffers = (SpatialSegmentRecord *)malloc (
      (size_t)builder.worker_count * SPATIAL_SORT_RUN_SEGMENTS
      * sizeof (SpatialSegmentRecord));
  builder.runs
      = (SpatialSortRun *)calloc ((size_t)run_capacity,
                                 sizeof (SpatialSortRun));
  if (!builder.buffers || !builder.runs)
    {
      if (!writer->failed)
        set_error (writer, "out of memory while preparing spatial sort");
      goto done;
    }
  builder.writer = writer;
  builder.overview = overview;
  builder.file = runs_file;
  builder.run_capacity = (size_t)run_capacity;
  collect_started = monotonic_nanoseconds ();
  if (!iterate_gpu_segments (dwg, tables, NULL, spatial_sort_consume,
                             &builder, &selected, NULL, NULL)
      || !queue_spatial_sort_run (&builder)
      || !flush_spatial_sort_batch (&builder)
      || selected != total || builder.records_written != total
      || builder.records_scheduled != total
      || fflush (runs_file) != 0)
    {
      if (!writer->failed)
        set_error (writer, "cannot prepare complete spatial geometry");
      goto done;
    }
  collect_total = elapsed_nanoseconds (collect_started);
  performance->spatial_sort_ms
      = milliseconds_from_nanoseconds (builder.sort_nanoseconds);
  performance->spatial_run_write_ms
      = milliseconds_from_nanoseconds (builder.write_nanoseconds);
  if (collect_total >= builder.sort_nanoseconds
                          + builder.write_nanoseconds)
    performance->spatial_collect_ms = milliseconds_from_nanoseconds (
        collect_total - builder.sort_nanoseconds
        - builder.write_nanoseconds);
  performance->parallel_sort_workers
      = builder.parallel_sort_workers
            ? builder.parallel_sort_workers
            : 1u;
  free (builder.buffers);
  builder.buffers = NULL;
  store->file = runs_file;
  store->runs = builder.runs;
  store->run_count = builder.run_count;
  store->count = total;
  runs_file = NULL;
  builder.runs = NULL;
  success = 1;

done:
  free (builder.runs);
  free (builder.buffers);
  if (runs_file)
    fclose (runs_file);
  return success;
}

static int
iterate_spatial_segment_store (CacheWriter *writer,
                               SpatialSegmentStore *store,
                               LineSegmentConsumer consumer, void *context,
                               uint64_t *selected)
{
  uint64_t started;
  int success;
  if (!store || !store->file || !store->runs || !store->run_count
      || !consumer)
    {
      set_error (writer, "spatial-sort geometry is unavailable");
      return 0;
    }
  started = monotonic_nanoseconds ();
  success = merge_spatial_sort_runs (
      writer, store->file, store->runs, store->run_count, consumer,
      context, store->count);
  store->merge_nanoseconds += elapsed_nanoseconds (started);
  if (success && selected)
    *selected = store->count;
  return success;
}

static double
position_error_bound (const double min[3], const double max[3],
                      const double origin[3])
{
  double maximum = 0.0;
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      double magnitude = fmax (fabs (min[axis] - origin[axis]),
                               fabs (max[axis] - origin[axis]));
      double error = magnitude * FLT_EPSILON
                     + (fabs (origin[axis]) + magnitude) * DBL_EPSILON
                     + ldexp (1.0, -149);
      maximum = fmax (maximum, error);
    }
  return maximum;
}

static int
write_batch_record (BatchDirectoryBuilder *builder)
{
  CacheWriter *writer = builder->writer;
  LibreDwgGpuLineSummary *summary = builder->summary;
  uint16_t kind;
  uint32_t block_index;
  uint32_t id;
  uint64_t vertex_count;
  uint64_t batch_bytes;
  double origin[3];
  double error;
  float encoded_error;
  size_t axis;
  if (!builder->count)
    return 1;
  if (summary->batches > UINT32_MAX)
    {
      set_error (writer, "too many GPU line batches");
      return 0;
    }
  id = (uint32_t)summary->batches;
  if (builder->current_group == UINT32_MAX)
    {
      kind = builder->separate_overview && builder->lod_level == 0 ? 0u : 1u;
      block_index = UINT32_MAX;
      if (kind == 0)
        summary->model_overview_batches++;
      else
        summary->model_detail_batches++;
    }
  else
    {
      kind = 2u;
      block_index = builder->current_group;
      summary->block_batches++;
      if (builder->lod_level == 0)
        summary->block_overview_batches++;
      else
        summary->block_detail_batches++;
    }
  vertex_count = (uint64_t)builder->count * 2u;
  batch_bytes = vertex_count * GPU_LINE_VERTEX_RECORD_SIZE;
  for (axis = 0; axis < 3; axis++)
    origin[axis] = builder->min[axis] * 0.5 + builder->max[axis] * 0.5;
  error = position_error_bound (builder->min, builder->max, origin);
  encoded_error = (float)error;
  if (!isfinite (encoded_error))
    {
      set_error (writer, "GPU batch coordinates exceed f32 range");
      return 0;
    }
  if ((double)encoded_error < error)
    encoded_error = nextafterf (encoded_error, INFINITY);
  if (!write_u32 (writer, id) || !write_u16 (writer, kind)
      || !write_u16 (writer, builder->lod_level)
      || !write_u32 (writer, builder->batch_flags)
      || !write_u32 (writer, block_index)
      || !write_u64 (writer, builder->first_vertex)
      || !write_u64 (writer, vertex_count)
      || !write_u32 (writer, builder->count) || !write_u32 (writer, 0)
      || !write_vec3 (writer, origin)
      || !write_vec3 (writer, builder->min)
      || !write_vec3 (writer, builder->max)
      || !write_f32 (writer, encoded_error) || !write_u32 (writer, 0)
      || !write_u64 (writer, 0))
    return 0;
  builder->first_vertex += vertex_count;
  summary->batches++;
  summary->maximum_batch_bytes
      = summary->maximum_batch_bytes > batch_bytes
            ? summary->maximum_batch_bytes
            : batch_bytes;
  summary->maximum_position_error
      = fmax (summary->maximum_position_error, error);
  builder->count = 0;
  builder->batch_flags = 0;
  builder->has_group = 0;
  return 1;
}

static void
include_batch_segment (BatchDirectoryBuilder *builder,
                       const LineSegment *segment)
{
  size_t axis;
  if (!builder->has_group)
    {
      builder->current_group = segment->group;
      builder->has_group = 1;
      for (axis = 0; axis < 3; axis++)
        {
          builder->min[axis]
              = fmin (segment->start[axis], segment->end[axis]);
          builder->max[axis]
              = fmax (segment->start[axis], segment->end[axis]);
        }
    }
  else
    {
      for (axis = 0; axis < 3; axis++)
        {
          builder->min[axis]
              = fmin (builder->min[axis],
                      fmin (segment->start[axis], segment->end[axis]));
          builder->max[axis]
              = fmax (builder->max[axis],
                      fmax (segment->start[axis], segment->end[axis]));
        }
    }
  if (segment->approximated_curve)
    builder->batch_flags |= GPU_BATCH_FLAG_APPROXIMATED_CURVE;
  builder->count++;
}

static uint32_t
gpu_vertex_style (const LineSegment *segment)
{
  static const int16_t line_weights[] = {
    -3, -2, -1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40,
    50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211
  };
  size_t line_weight_index;
  uint32_t style;
  for (line_weight_index = 0;
       line_weight_index
       < sizeof (line_weights) / sizeof (line_weights[0]);
       line_weight_index++)
    if (line_weights[line_weight_index] == segment->line_weight)
      break;
  if (line_weight_index
      == sizeof (line_weights) / sizeof (line_weights[0]))
    line_weight_index = 2;
  style = (uint32_t)line_weight_index;
  style
      |= ((uint32_t)segment->linetype_code & GPU_STYLE_LINETYPE_MASK)
         << GPU_STYLE_LINETYPE_SHIFT;
  if (segment->flags & 1u)
    style |= GPU_STYLE_INVISIBLE;
  style |= (uint32_t)segment->source_kind
           << GPU_STYLE_SOURCE_KIND_SHIFT;
  if (segment->approximated_curve)
    style |= GPU_STYLE_APPROXIMATED_CURVE;
  return style;
}

static int
encode_gpu_vertex (CacheWriter *writer, uint8_t *record,
                   const double point[3], const double origin[3],
                   const LineSegment *segment, uint32_t style,
                   double pattern)
{
  size_t axis;
  for (axis = 0; axis < 3; axis++)
    {
      float encoded = (float)(point[axis] - origin[axis]);
      if (!isfinite (encoded))
        {
          set_error (writer, "GPU vertex exceeds f32 range");
          return 0;
        }
      store_f32_le (record + axis * 4u, encoded);
    }
  store_u32_le (record + 12u, segment->layer_index);
  store_u32_le (record + 16u, segment->color);
  store_u32_le (record + 20u, (uint32_t)segment->handle);
  store_u32_le (record + 24u, (uint32_t)(segment->handle >> 32));
  store_u32_le (record + 28u, style);
  store_f32_le (record + 32u, (float)pattern);
  return 1;
}

static int
flush_gpu_section_batch (GpuSectionBuilder *builder)
{
  BatchDirectoryBuilder *batches = &builder->batches;
  double origin[3];
  uint32_t index;
  size_t axis;
  size_t byte_length;
  if (!batches->count)
    return 1;
  for (axis = 0; axis < 3; axis++)
    origin[axis]
        = batches->min[axis] * 0.5 + batches->max[axis] * 0.5;
  for (index = 0; index < batches->count; index++)
    {
      const LineSegment *segment = &builder->segments[index];
      uint8_t *start
          = builder->vertex_bytes
            + (size_t)index * 2u * GPU_LINE_VERTEX_RECORD_SIZE;
      uint8_t *end = start + GPU_LINE_VERTEX_RECORD_SIZE;
      uint32_t style = gpu_vertex_style (segment);
      if (!encode_gpu_vertex (
              batches->writer, start, segment->start, origin,
              segment, style, segment->pattern_start)
          || !encode_gpu_vertex (
              batches->writer, end, segment->end, origin,
              segment, style, segment->pattern_end))
        return 0;
    }
  byte_length = (size_t)batches->count * 2u
                * GPU_LINE_VERTEX_RECORD_SIZE;
  if (!write_bytes (
          builder->vertex_writer, builder->vertex_bytes, byte_length))
    {
      if (!batches->writer->failed)
        set_error (batches->writer,
                   "cannot stage packed GPU line vertices");
      return 0;
    }
  builder->vertices += (uint64_t)batches->count * 2u;
  return write_batch_record (batches);
}

static int
gpu_section_consume (void *context, const LineSegment *segment)
{
  GpuSectionBuilder *builder = (GpuSectionBuilder *)context;
  BatchDirectoryBuilder *batches = &builder->batches;
  if (batches->has_group
      && (batches->current_group != segment->group
          || batches->count == GPU_BATCH_SEGMENTS)
      && !flush_gpu_section_batch (builder))
    return 0;
  builder->segments[batches->count] = *segment;
  include_batch_segment (batches, segment);
  return 1;
}

static int
write_gpu_pass (CacheWriter *writer, CacheWriter *vertex_writer,
                const Dwg_Data *dwg, const CacheTables *tables,
                LibreDwgGpuLineSummary *summary,
                OverviewPlan *overview, SpatialSegmentStore *spatial,
                uint16_t lod_level, int separate_overview,
                uint64_t *selected)
{
  GpuSectionBuilder builder;
  uint64_t first_vertex = summary->vertices;
  int success = 0;
  memset (&builder, 0, sizeof (builder));
  builder.batches.writer = writer;
  builder.batches.summary = summary;
  builder.batches.lod_level = lod_level;
  builder.batches.separate_overview = separate_overview;
  builder.batches.first_vertex = first_vertex;
  builder.vertex_writer = vertex_writer;
  builder.segments
      = (LineSegment *)malloc (GPU_BATCH_SEGMENTS * sizeof (LineSegment));
  builder.vertex_bytes = (uint8_t *)malloc (
      GPU_BATCH_SEGMENTS * 2u * GPU_LINE_VERTEX_RECORD_SIZE);
  if (!builder.segments || !builder.vertex_bytes)
    {
      set_error (writer, "out of memory while writing GPU cache");
      goto done;
    }
  if (!(spatial
            ? iterate_spatial_segment_store (
                  writer, spatial, gpu_section_consume, &builder, selected)
            : iterate_gpu_segments (
                  dwg, tables, overview, gpu_section_consume, &builder,
                  selected, NULL, NULL))
      || !flush_gpu_section_batch (&builder))
    goto done;
  if (builder.batches.first_vertex < first_vertex
      || builder.vertices
             != builder.batches.first_vertex - first_vertex)
    {
      set_error (writer, "GPU batch and vertex counts differ");
      goto done;
    }
  summary->vertices = builder.batches.first_vertex;
  success = 1;

done:
  free (builder.vertex_bytes);
  free (builder.segments);
  return success;
}

static int
write_gpu_sections (CacheWriter *writer, const Dwg_Data *dwg,
                    const CacheTables *tables,
                    LibreDwgGpuLineSummary *summary,
                    OverviewPlan *overview,
                    SpatialSegmentStore *spatial,
                    SectionEntry *batch_entry,
                    SectionEntry *vertex_entry, int overview_only,
                    int direct_output,
                    FILE **prefix_file, uint64_t *prefix_byte_length)
{
  CacheWriter staging_writer;
  CacheWriter *batch_writer = writer;
  CacheWriter *vertex_writer = &staging_writer;
  FILE *staging_file = NULL;
  uint8_t copy_buffer[64u * 1024u];
  char staging_error[160];
  uint64_t batch_offset;
  uint64_t vertex_offset;
  uint64_t vertex_end;
  uint64_t staged_bytes;
  uint64_t remaining;
  uint64_t selected = 0;
  uint64_t before_batches = summary->batches;
  uint64_t batch_count;
  uint64_t prefix_bytes = 0;
  uint64_t total
      = summary->model_segments + summary->block_segments;
  int separate_overview = total > SCENE_OVERVIEW_SEGMENTS;
  int split_output
      = !overview_only && !direct_output && prefix_file
        && prefix_byte_length;
  int success = 0;
  memset (&staging_writer, 0, sizeof (staging_writer));
  memset (staging_error, 0, sizeof (staging_error));
  if (prefix_file)
    *prefix_file = NULL;
  if (prefix_byte_length)
    *prefix_byte_length = 0;
  if (separate_overview && !overview_only
      && (!spatial || !spatial->file || !spatial->runs
          || !spatial->run_count || spatial->count != total))
    {
      set_error (writer, "spatial-sort geometry count is inconsistent");
      return 0;
    }
  staging_file = open_spatial_temp_file (writer);
  if (!staging_file)
    return 0;
  staging_writer.file = staging_file;
  staging_writer.error = staging_error;
  staging_writer.error_size = sizeof (staging_error);
  if (split_output || direct_output)
    {
      batch_writer = &staging_writer;
      vertex_writer = writer;
    }
  if (!align_writer (batch_writer, &batch_offset)
      || !align_writer (vertex_writer, &vertex_offset))
    goto done;
  if (separate_overview)
    {
      if (!write_gpu_pass (
              batch_writer, vertex_writer, dwg, tables, summary, overview,
              NULL, 0, 1, &selected))
        goto done;
      summary->overview_segments = selected;
      if (!overview_only
          && !write_gpu_pass (
              batch_writer, vertex_writer, dwg, tables, summary, NULL,
              spatial, 1, 1, NULL))
        goto done;
    }
  else
    {
      summary->overview_segments = total;
      if (!write_gpu_pass (
              batch_writer, vertex_writer, dwg, tables, summary, NULL,
              NULL, 0, 0, NULL))
        goto done;
    }
  batch_count = summary->batches - before_batches;
  if (!finish_fixed_section (
          batch_writer, batch_entry, SECTION_GPU_LINE_BATCHES,
          GPU_LINE_BATCH_RECORD_SIZE, "gpu_line_batches", batch_offset,
          batch_count)
      || !position (vertex_writer, &vertex_end)
      || vertex_end < vertex_offset
      || (staged_bytes = vertex_end - vertex_offset)
             != summary->vertices * GPU_LINE_VERTEX_RECORD_SIZE
      || fflush (staging_file) != 0)
    {
      if (!writer->failed)
        set_error (writer, "packed GPU section staging is incomplete");
      goto done;
    }
  if (direct_output)
    {
      if (!position (batch_writer, &prefix_bytes)
          || fseeko (staging_file, 0, SEEK_SET) != 0
          || !finish_fixed_section (
              writer, vertex_entry, SECTION_GPU_LINE_VERTICES,
              GPU_LINE_VERTEX_RECORD_SIZE, "gpu_line_vertices",
              vertex_offset, summary->vertices)
          || !align_writer (writer, &batch_offset))
        {
          if (!writer->failed)
            set_error (writer, "packed GPU direct output is incomplete");
          goto done;
        }
      remaining = prefix_bytes;
      while (remaining)
        {
          size_t requested
              = remaining < sizeof (copy_buffer)
                    ? (size_t)remaining
                    : sizeof (copy_buffer);
          if (fread (copy_buffer, 1, requested, staging_file)
                  != requested
              || !write_bytes (writer, copy_buffer, requested))
            {
              set_error (writer, "cannot append packed GPU batches");
              goto done;
            }
          remaining -= requested;
        }
      if (!finish_fixed_section (
              writer, batch_entry, SECTION_GPU_LINE_BATCHES,
              GPU_LINE_BATCH_RECORD_SIZE, "gpu_line_batches",
              batch_offset, batch_count))
        goto done;
    }
  else if (split_output)
    {
      if (!position (batch_writer, &prefix_bytes)
          || fseeko (staging_file, 0, SEEK_SET) != 0
          || !finish_fixed_section (
              writer, vertex_entry, SECTION_GPU_LINE_VERTICES,
              GPU_LINE_VERTEX_RECORD_SIZE, "gpu_line_vertices",
              vertex_offset, summary->vertices)
          || vertex_entry->offset > UINT64_MAX - prefix_bytes)
        {
          if (!writer->failed)
            set_error (writer, "packed GPU split output is incomplete");
          goto done;
        }
      vertex_entry->offset += prefix_bytes;
      *prefix_file = staging_file;
      *prefix_byte_length = prefix_bytes;
      staging_file = NULL;
    }
  else
    {
      if (fseeko (staging_file, 0, SEEK_SET) != 0
          || !align_writer (writer, &vertex_offset))
        {
          set_error (writer, "packed GPU vertex staging is incomplete");
          goto done;
        }
      remaining = staged_bytes;
      while (remaining)
        {
          size_t requested
              = remaining < sizeof (copy_buffer)
                    ? (size_t)remaining
                    : sizeof (copy_buffer);
          if (fread (copy_buffer, 1, requested, staging_file)
                  != requested
              || !write_bytes (writer, copy_buffer, requested))
            {
              set_error (writer, "cannot concatenate packed GPU vertices");
              goto done;
            }
          remaining -= requested;
        }
      if (!finish_fixed_section (
              writer, vertex_entry, SECTION_GPU_LINE_VERTICES,
              GPU_LINE_VERTEX_RECORD_SIZE, "gpu_line_vertices",
              vertex_offset, summary->vertices))
        goto done;
    }
  summary->cached_vertex_bytes
      = summary->vertices * GPU_LINE_VERTEX_RECORD_SIZE;
  summary->first_frame_vertex_bytes
      = summary->overview_segments * 2u * GPU_LINE_VERTEX_RECORD_SIZE;
  summary->full_detail_vertex_bytes
      = (summary->model_segments + summary->block_segments) * 2u
        * GPU_LINE_VERTEX_RECORD_SIZE;
  success = 1;

done:
  if (!success && staging_writer.failed && !writer->failed)
    set_error (writer, staging_error[0]
                           ? staging_error
                           : "cannot stage packed GPU section data");
  if (staging_file)
    fclose (staging_file);
  return success;
}

#define SECTION_GROUP_COUNT 7u

typedef struct
{
  size_t group;
  FILE *file;
  FILE *prefix_file;
  Dwg_Data *dwg;
  const CacheTables *tables;
  const LibreDwgPrimitiveCounts *counts;
  LibreDwgGpuLineSummary *gpu_lines;
  LibreDwgHatchFillSummary *hatch_fills;
  OverviewPlan *overview;
  SpatialSegmentStore *spatial;
  SectionEntry *sections;
  uint32_t source_version;
  uint32_t wipeout_frame;
  uint32_t presentation_settings;
  uint64_t prefix_byte_length;
  uint64_t byte_length;
  uint64_t elapsed;
  char error[160];
  int direct_output;
  int owns_file;
  int success;
} SectionGroupTask;

typedef struct
{
  SectionGroupTask *tasks;
  size_t count;
  atomic_size_t next;
} SectionGroupQueue;

static void
write_section_group (SectionGroupTask *task)
{
  CacheWriter writer;
  uint64_t started = monotonic_nanoseconds ();
  uint64_t output_start = 0;
  uint64_t main_byte_length = 0;
  int success = 0;
  memset (&writer, 0, sizeof (writer));
  writer.file = task->file;
  writer.error = task->error;
  writer.error_size = sizeof (task->error);
  if (!position (&writer, &output_start))
    goto done;
  switch (task->group)
    {
    case 0:
      success
          = write_drawing_section (
                &writer, task->dwg, task->counts,
                task->source_version, task->wipeout_frame,
                task->presentation_settings,
                &task->sections[0])
            && write_layer_section (
                &writer, task->tables, &task->sections[1])
            && write_block_section (
                &writer, task->tables, &task->sections[2])
            && write_text_style_section (
                &writer, task->tables, &task->sections[3]);
      break;
    case 1:
      success
          = write_line_section (
                &writer, task->dwg, task->tables, &task->sections[4])
            && write_arc_section (
                &writer, task->dwg, task->tables, &task->sections[5])
            && write_circle_section (
                &writer, task->dwg, task->tables, &task->sections[6])
            && write_insert_section (
                &writer, task->dwg, task->tables, &task->sections[7])
            && write_polyline_header_section (
                &writer, task->dwg, task->tables, &task->sections[8])
            && write_polyline_vertex_section (
                &writer, task->dwg, &task->sections[9]);
      break;
    case 2:
      success
          = write_ellipse_section (
                &writer, task->dwg, task->tables, &task->sections[10])
            && write_spline_header_section (
                &writer, task->dwg, task->tables, &task->sections[11])
            && write_spline_knot_section (
                &writer, task->dwg, &task->sections[12])
            && write_spline_weight_section (
                &writer, task->dwg, &task->sections[13])
            && write_spline_control_point_section (
                &writer, task->dwg, &task->sections[14])
            && write_spline_fit_point_section (
                &writer, task->dwg, &task->sections[15])
            && write_text_entity_section (
                &writer, task->dwg, task->tables, &task->sections[16])
            && write_text_column_height_section (
                &writer, task->dwg, &task->sections[17]);
      break;
    case 3:
      success
          = write_gpu_sections (
                &writer, task->dwg, task->tables, task->gpu_lines,
                task->overview, task->spatial, &task->sections[18],
                &task->sections[19], 0, task->direct_output,
                &task->prefix_file,
                &task->prefix_byte_length);
      break;
    case 4:
      success
          = write_hatch_entity_section (
                &writer, task->dwg, task->tables, task->counts,
                task->hatch_fills, &task->sections[20])
            && write_hatch_loop_section (
                &writer, task->dwg, &task->sections[21])
            && write_hatch_vertex_section (
                &writer, task->dwg, &task->sections[22])
            && write_hatch_gradient_color_section (
                &writer, task->dwg, &task->sections[23])
            && write_hatch_seed_point_section (
                &writer, task->dwg, &task->sections[24])
            && write_hatch_pattern_line_section (
                &writer, task->dwg, &task->sections[25])
            && write_hatch_pattern_dash_section (
                &writer, task->dwg, &task->sections[26]);
      break;
    case 5:
      success
          = write_point_entity_section (
                &writer, task->dwg, task->tables, &task->sections[27])
            && write_solid_entity_section (
                &writer, task->dwg, task->tables, &task->sections[28])
            && write_face_entity_section (
                &writer, task->dwg, task->tables, &task->sections[29])
            && write_wipeout_entity_section (
                &writer, task->dwg, task->tables, &task->sections[30])
            && write_wipeout_clip_vertex_section (
                &writer, task->dwg, &task->sections[31])
            && write_draw_order_table_section (
                &writer, task->dwg, &task->sections[32])
            && write_draw_order_entry_section (
                &writer, task->dwg, &task->sections[33])
            && write_insert_clip_section (
                &writer, task->dwg, &task->sections[34])
            && write_insert_clip_vertex_section (
                &writer, task->dwg, &task->sections[35]);
      break;
    case 6:
      {
        EmbeddedImageTable embedded_images;
        memset (&embedded_images, 0, sizeof (embedded_images));
        success
            = collect_embedded_image_table (
                  &writer, task->dwg, &embedded_images)
              && write_linetype_section (
                &writer, task->dwg, task->tables, &task->sections[36])
            && write_linetype_dash_section (
                &writer, task->dwg, task->tables, &task->sections[37])
            && write_layout_section (
                &writer, task->dwg, task->tables, &task->sections[38])
            && write_viewport_section (
                &writer, task->dwg, task->tables, &task->sections[39])
            && write_viewport_frozen_layer_section (
                &writer, task->dwg, task->tables, &task->sections[40])
            && write_viewport_clip_vertex_section (
                &writer, task->dwg, task->tables, &task->sections[41])
            && write_image_entity_section (
                &writer, task->dwg, task->tables, &embedded_images,
                &task->sections[42])
            && write_image_clip_vertex_section (
                &writer, task->dwg, &task->sections[43])
            && write_text_annotation_context_section (
                &writer, task->dwg, &task->sections[44])
            && write_text_annotation_column_height_section (
                &writer, task->dwg, &task->sections[45])
            && write_viewport_layer_override_section (
                &writer, task->dwg, task->tables, &task->sections[46])
            && write_embedded_image_record_section (
                &writer, &embedded_images, &task->sections[47])
            && write_embedded_image_byte_section (
                &writer, &embedded_images, &task->sections[48])
            && write_curve_linetype_scale_section (
                &writer, task->dwg, &task->sections[49])
            && write_construction_line_section (
                &writer, task->dwg, task->tables,
                &task->sections[50]);
        free_embedded_image_table (&embedded_images);
        break;
      }
    default:
      set_error (&writer, "scene-cache section group is invalid");
      break;
    }
  if (success)
    {
      if (!position (&writer, &main_byte_length)
          || fflush (task->file) != 0
          || main_byte_length < output_start
          || main_byte_length - output_start
                 > UINT64_MAX - task->prefix_byte_length)
        success = 0;
      else
        task->byte_length
            = task->prefix_byte_length
              + main_byte_length - output_start;
    }
  if (!success && !writer.failed)
    set_error (&writer, "cannot write scene-cache section group");
done:
  task->success = success;
  task->elapsed = elapsed_nanoseconds (started);
}

static void
consume_section_group_queue (SectionGroupQueue *queue)
{
  for (;;)
    {
      size_t index = atomic_fetch_add_explicit (
          &queue->next, 1u, memory_order_relaxed);
      if (index >= queue->count)
        return;
      write_section_group (&queue->tasks[index]);
    }
}

#if defined(_WIN32)
static unsigned __stdcall
write_section_group_thread (void *context)
{
  consume_section_group_queue ((SectionGroupQueue *)context);
  return 0;
}
#elif !defined(__EMSCRIPTEN__)
static void *
write_section_group_thread (void *context)
{
  consume_section_group_queue ((SectionGroupQueue *)context);
  return NULL;
}
#endif

static uint32_t
run_section_group_queue (SectionGroupQueue *queue, uint32_t worker_count)
{
  size_t launched = 0;
  size_t desired
      = worker_count < queue->count ? worker_count : queue->count;
  size_t index;
  if (desired < 1)
    desired = 1;
#if defined(_WIN32)
  {
    HANDLE threads[SECTION_GROUP_COUNT - 1u];
    for (index = 0; index + 1u < desired; index++)
      {
        uintptr_t thread = _beginthreadex (
            NULL, 0, write_section_group_thread, queue, 0, NULL);
        if (!thread)
          break;
        threads[launched++] = (HANDLE)thread;
      }
    consume_section_group_queue (queue);
    for (index = 0; index < launched; index++)
      {
        (void)WaitForSingleObject (threads[index], INFINITE);
        (void)CloseHandle (threads[index]);
      }
  }
#elif defined(__EMSCRIPTEN__)
  consume_section_group_queue (queue);
#else
  {
    pthread_t threads[SECTION_GROUP_COUNT - 1u];
    for (index = 0; index + 1u < desired; index++)
      {
        if (pthread_create (&threads[launched], NULL,
                            write_section_group_thread, queue)
            != 0)
          break;
        launched++;
      }
    consume_section_group_queue (queue);
    for (index = 0; index < launched; index++)
      (void)pthread_join (threads[index], NULL);
  }
#endif
  return (uint32_t)(launched + 1u);
}

static int
write_section_groups (
    CacheWriter *writer, Dwg_Data *dwg, const CacheTables *tables,
    const LibreDwgPrimitiveCounts *counts, uint32_t source_version,
    uint32_t wipeout_frame, uint32_t presentation_settings,
    LibreDwgGpuLineSummary *gpu_lines,
    OverviewPlan *overview, SpatialSegmentStore *spatial,
    LibreDwgHatchFillSummary *hatch_fills, SectionEntry *sections,
    LibreDwgSceneCachePerformance *performance)
{
  static const size_t first_sections[SECTION_GROUP_COUNT]
      = { 0, 4, 10, 18, 20, 27, 36 };
  static const size_t last_sections[SECTION_GROUP_COUNT]
      = { 3, 9, 17, 19, 26, 35, 50 };
  SectionGroupTask tasks[SECTION_GROUP_COUNT];
  SectionGroupQueue queue;
  uint8_t copy_buffer[64u * 1024u];
  size_t group;
  int success = 0;
  memset (tasks, 0, sizeof (tasks));
  for (group = 0; group < SECTION_GROUP_COUNT; group++)
    {
      tasks[group].group = group;
      tasks[group].dwg = dwg;
      tasks[group].tables = tables;
      tasks[group].counts = counts;
      tasks[group].gpu_lines = gpu_lines;
      tasks[group].hatch_fills = hatch_fills;
      tasks[group].overview = overview;
      tasks[group].spatial = spatial;
      tasks[group].sections = sections;
      tasks[group].source_version = source_version;
      tasks[group].wipeout_frame = wipeout_frame;
      tasks[group].presentation_settings = presentation_settings;
      if (group == 3u)
        {
          tasks[group].file = writer->file;
          tasks[group].direct_output = 1;
        }
      else
        {
          tasks[group].file = open_spatial_temp_file (writer);
          tasks[group].owns_file = 1;
          if (!tasks[group].file)
            goto done;
        }
    }
  queue.tasks = tasks;
  queue.count = SECTION_GROUP_COUNT;
  atomic_init (&queue.next, 0u);
  performance->parallel_section_workers = run_section_group_queue (
      &queue, performance->worker_count);
  performance->spatial_merge_ms = milliseconds_from_nanoseconds (
      spatial ? spatial->merge_nanoseconds : 0);
  for (group = 0; group < SECTION_GROUP_COUNT; group++)
    {
      uint64_t base;
      uint64_t source_lengths[2];
      FILE *source_files[2];
      size_t source_count = 0;
      size_t source_index;
      size_t section;
      performance->section_group_ms[group]
          = milliseconds_from_nanoseconds (tasks[group].elapsed);
      if (!tasks[group].success)
        {
          set_error (writer, tasks[group].error[0]
                                 ? tasks[group].error
                                 : "cannot write scene-cache section group");
          goto done;
        }
      if (tasks[group].direct_output)
        continue;
      if (!align_writer (writer, &base))
        {
          set_error (writer, "cannot concatenate scene-cache sections");
          goto done;
        }
      if (tasks[group].prefix_file)
        {
          source_files[source_count] = tasks[group].prefix_file;
          source_lengths[source_count++]
              = tasks[group].prefix_byte_length;
        }
      source_files[source_count] = tasks[group].file;
      source_lengths[source_count++]
          = tasks[group].byte_length
            - tasks[group].prefix_byte_length;
      for (source_index = 0; source_index < source_count;
           source_index++)
        {
          uint64_t remaining = source_lengths[source_index];
          if (fseeko (source_files[source_index], 0, SEEK_SET) != 0)
            {
              set_error (writer, "cannot concatenate scene-cache sections");
              goto done;
            }
          while (remaining)
            {
              size_t requested
                  = remaining < sizeof (copy_buffer)
                        ? (size_t)remaining
                        : sizeof (copy_buffer);
              if (fread (
                      copy_buffer, 1, requested,
                      source_files[source_index])
                      != requested
                  || !write_bytes (writer, copy_buffer, requested))
                {
                  set_error (
                      writer, "cannot concatenate scene-cache sections");
                  goto done;
                }
              remaining -= requested;
            }
        }
      for (section = first_sections[group];
           section <= last_sections[group]; section++)
        {
          if (sections[section].offset > UINT64_MAX - base)
            {
              set_error (writer, "scene-cache section offset overflow");
              goto done;
            }
          sections[section].offset += base;
        }
    }
  success = 1;

done:
  for (group = 0; group < SECTION_GROUP_COUNT; group++)
    {
      if (tasks[group].prefix_file)
        fclose (tasks[group].prefix_file);
      if (tasks[group].owns_file && tasks[group].file)
        fclose (tasks[group].file);
    }
  return success;
}

static int
write_header (CacheWriter *writer, uint64_t file_size, uint64_t source_size,
              uint32_t source_version, uint32_t maintenance_version,
              uint32_t flags)
{
  if (!seek_to (writer, 0) || !write_bytes (writer, CACHE_MAGIC, 8)
      || !write_u16 (writer, CACHE_VERSION_MAJOR)
      || !write_u16 (writer, CACHE_VERSION_MINOR)
      || !write_u32 (writer, CACHE_HEADER_SIZE)
      || !write_u32 (writer, LIBREDWG_SCENE_SECTION_COUNT)
      || !write_u32 (writer, DIRECTORY_ENTRY_SIZE)
      || !write_u32 (writer, flags) || !write_u32 (writer, 0)
      || !write_u64 (writer, CACHE_HEADER_SIZE)
      || !write_u64 (writer, file_size)
      || !write_u64 (writer, source_size)
      || !write_u32 (writer, source_version)
      || !write_u32 (writer, maintenance_version))
    return 0;
  return 1;
}

static int
write_directory (CacheWriter *writer, const SectionEntry *sections)
{
  size_t i;
  if (!seek_to (writer, CACHE_HEADER_SIZE))
    return 0;
  for (i = 0; i < LIBREDWG_SCENE_SECTION_COUNT; i++)
    {
      if (!write_u32 (writer, sections[i].kind)
          || !write_u32 (writer, sections[i].record_size)
          || !write_u64 (writer, sections[i].offset)
          || !write_u64 (writer, sections[i].byte_length)
          || !write_u64 (writer, sections[i].record_count)
          || !write_u32 (writer, sections[i].flags)
          || !write_u32 (writer, 0))
        return 0;
    }
  return 1;
}

static int
write_empty_fixed_section (CacheWriter *writer, SectionEntry *entry,
                           size_t index)
{
  uint64_t offset;
  return align_writer (writer, &offset)
         && finish_fixed_section (
             writer, entry, SECTION_KINDS[index],
             SECTION_RECORD_SIZES[index], SECTION_NAMES[index], offset, 0);
}

static int
write_empty_string_section (CacheWriter *writer, SectionEntry *entry,
                            size_t index)
{
  uint64_t offset;
  if (!align_writer (writer, &offset) || !write_u32 (writer, 0)
      || !write_u32 (writer, SECTION_RECORD_SIZES[index])
      || !write_u64 (writer, STRING_TABLE_HEADER_SIZE))
    return 0;
  return finish_variable_section (
      writer, entry, SECTION_KINDS[index], SECTION_RECORD_SIZES[index],
      SECTION_NAMES[index], offset, 0, SECTION_FLAG_STRING_TABLE);
}

static int
write_scene_preview (
    Dwg_Data *dwg, const char *output_path, uint64_t source_size,
    uint32_t source_version, uint32_t wipeout_frame,
    uint32_t presentation_settings,
    const CacheTables *tables, const LibreDwgPrimitiveCounts *counts,
    const LibreDwgGpuLineSummary *gpu_lines, OverviewPlan *overview,
    uint64_t *preview_size)
{
  CacheWriter writer;
  SectionEntry sections[LIBREDWG_SCENE_SECTION_COUNT];
  LibreDwgGpuLineSummary preview_gpu_lines;
  uint64_t body_offset;
  uint64_t file_size;
  int descriptor = -1;
  FILE *file = NULL;
  size_t index;
  int created = 0;
  int success = 0;
  char error_message[160];

  memset (&writer, 0, sizeof (writer));
  memset (sections, 0, sizeof (sections));
  memset (&preview_gpu_lines, 0, sizeof (preview_gpu_lines));
  memset (error_message, 0, sizeof (error_message));
  preview_gpu_lines.model_segments = gpu_lines->model_segments;
  preview_gpu_lines.block_segments = gpu_lines->block_segments;
  writer.error = error_message;
  writer.error_size = sizeof (error_message);

  descriptor
      = open (output_path,
              O_WRONLY | O_CREAT | O_EXCL | O_BINARY, 0600);
  if (descriptor < 0)
    goto done;
  created = 1;
  file = fdopen (descriptor, "wb");
  if (!file)
    {
      close (descriptor);
      descriptor = -1;
      goto done;
    }
  descriptor = -1;
  writer.file = file;
  body_offset = align_up (
      CACHE_HEADER_SIZE
          + (uint64_t)LIBREDWG_SCENE_SECTION_COUNT * DIRECTORY_ENTRY_SIZE,
      8);
  if (!seek_to (&writer, body_offset)
      || !write_drawing_section (
          &writer, dwg, counts, source_version, wipeout_frame,
          presentation_settings,
          &sections[0])
      || !write_layer_section (&writer, tables, &sections[1])
      || !write_block_section (&writer, tables, &sections[2])
      || !write_empty_string_section (&writer, &sections[3], 3))
    goto done;
  for (index = 4; index <= 6; index++)
    if (!write_empty_fixed_section (&writer, &sections[index], index))
      goto done;
  if (!write_insert_section (&writer, dwg, tables, &sections[7]))
    goto done;
  for (index = 8; index <= 15; index++)
    if (!write_empty_fixed_section (&writer, &sections[index], index))
      goto done;
  if (!write_empty_string_section (&writer, &sections[16], 16)
      || !write_empty_fixed_section (&writer, &sections[17], 17)
      || !write_gpu_sections (
          &writer, dwg, tables, &preview_gpu_lines, overview, NULL,
          &sections[18], &sections[19], 1, 0, NULL, NULL)
      || !write_empty_string_section (&writer, &sections[20], 20))
    goto done;
  for (index = 21; index <= 33; index++)
    if (!write_empty_fixed_section (&writer, &sections[index], index))
      goto done;
  if (!write_insert_clip_section (&writer, dwg, &sections[34])
      || !write_insert_clip_vertex_section (
          &writer, dwg, &sections[35])
      || !write_linetype_section (&writer, dwg, tables, &sections[36])
      || !write_linetype_dash_section (
          &writer, dwg, tables, &sections[37])
      || !write_layout_section (
          &writer, dwg, tables, &sections[38])
      || !write_viewport_section (
          &writer, dwg, tables, &sections[39])
      || !write_viewport_frozen_layer_section (
          &writer, dwg, tables, &sections[40])
      || !write_empty_fixed_section (&writer, &sections[41], 41)
      || !write_empty_string_section (&writer, &sections[42], 42)
      || !write_empty_fixed_section (&writer, &sections[43], 43)
      || !write_empty_fixed_section (&writer, &sections[44], 44)
      || !write_empty_fixed_section (&writer, &sections[45], 45)
      || !write_viewport_layer_override_section (
          &writer, dwg, tables, &sections[46])
      || !write_empty_fixed_section (&writer, &sections[47], 47)
      || !write_empty_fixed_section (&writer, &sections[48], 48)
      || !write_empty_fixed_section (&writer, &sections[49], 49)
      || !write_empty_fixed_section (&writer, &sections[50], 50))
    goto done;
  if (!position (&writer, &file_size)
      || !write_header (
          &writer, file_size, source_size, source_version,
          (uint32_t)LIBREDWG_MAINTENANCE_VERSION (dwg),
          CACHE_HEADER_FLAG_PREVIEW)
      || !write_directory (&writer, sections)
      || !flush_writer (&writer) || fflush (file) != 0)
    goto done;
  if (fclose (file) != 0)
    {
      file = NULL;
      goto done;
    }
  file = NULL;
  *preview_size = file_size;
  success = 1;

done:
  if (file)
    fclose (file);
  if (descriptor >= 0)
    close (descriptor);
  if (!success && created)
    unlink (output_path);
  return success;
}

static int
create_preview_ready_file (const char *path)
{
  int descriptor
      = open (path, O_WRONLY | O_CREAT | O_EXCL | O_BINARY, 0600);
  if (descriptor < 0)
    return 0;
  if (close (descriptor) != 0)
    {
      unlink (path);
      return 0;
    }
  return 1;
}

int
libredwg_write_scene_cache (
    Dwg_Data *dwg, const char *output_path, const char *preview_path,
    const char *preview_ready_path, uint64_t source_size,
    uint32_t source_version, LibreDwgSceneCacheReport *report,
    char *error_message, size_t error_message_size)
{
  CacheTables tables;
  CacheWriter writer;
  SectionEntry sections[LIBREDWG_SCENE_SECTION_COUNT];
  LibreDwgPrimitiveCounts counts;
  LibreDwgGpuLineSummary gpu_lines;
  LibreDwgHatchFillSummary hatch_fills;
  OverviewPlan overview;
  SpatialSegmentStore spatial;
  uint64_t body_offset;
  uint64_t file_size;
  uint64_t gpu_segment_count;
  uint64_t stage_started;
  uint32_t wipeout_frame;
  uint32_t presentation_settings;
  int descriptor = -1;
  FILE *file = NULL;
  size_t i;
  int created = 0;
  int success = 0;

  memset (report, 0, sizeof (*report));
  memset (&writer, 0, sizeof (writer));
  memset (sections, 0, sizeof (sections));
  memset (&gpu_lines, 0, sizeof (gpu_lines));
  memset (&hatch_fills, 0, sizeof (hatch_fills));
  memset (&overview, 0, sizeof (overview));
  memset (&spatial, 0, sizeof (spatial));
  if (error_message && error_message_size)
    error_message[0] = '\0';
  writer.error = error_message;
  writer.error_size = error_message_size;
  report->performance.worker_count = conversion_worker_count ();
  report->performance.parallel_sort_workers = 1u;
  report->performance.parallel_section_workers = 1u;

  stage_started = monotonic_nanoseconds ();
  dwg_resolve_objectrefs_silent (dwg);
  if (dwg->dirty_refs)
    {
      set_error (&writer, "cannot freeze LibreDWG object references");
      return 0;
    }
  report->performance.reference_resolution_ms
      = milliseconds_from_nanoseconds (
          elapsed_nanoseconds (stage_started));
  stage_started = monotonic_nanoseconds ();
  if (!build_tables (dwg, &tables))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot prepare bounded scene-cache tables");
      return 0;
    }
  report->source_linetypes = tables.source_linetype_count;
  report->serialized_linetypes = tables.linetype_count;
  report->referenced_linetypes = tables.referenced_linetype_count;
  report->omitted_referenced_linetypes
      = tables.omitted_referenced_linetype_count;
  report->performance.table_ms = milliseconds_from_nanoseconds (
      elapsed_nanoseconds (stage_started));
  stage_started = monotonic_nanoseconds ();
  counts = count_primitives (dwg, &tables);
  report->performance.primitive_count_ms
      = milliseconds_from_nanoseconds (
          elapsed_nanoseconds (stage_started));
  stage_started = monotonic_nanoseconds ();
  if (!read_drawing_wipeout_frame (&writer, dwg, &wipeout_frame))
    goto done;
  if (!read_drawing_presentation_settings (
          &writer, dwg, &presentation_settings))
    goto done;
  tables.presentation_settings = presentation_settings;
  if (!initialize_overview_plan (&tables, &overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot allocate bounded overview plan");
      goto done;
    }
  if (!count_gpu_segments (dwg, &tables, &gpu_lines, &overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot count bounded GPU segments");
      goto done;
    }
  if (!finalize_overview_quotas (&overview))
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot allocate bounded overview quotas");
      goto done;
    }
  report->performance.gpu_count_ms = milliseconds_from_nanoseconds (
      elapsed_nanoseconds (stage_started));
  if (UINT64_MAX - gpu_lines.model_segments < gpu_lines.block_segments)
    {
      set_error (&writer, "GPU segment count exceeds cache limits");
      goto done;
    }
  if (preview_path && preview_path[0] && preview_ready_path
      && preview_ready_path[0])
    {
      stage_started = monotonic_nanoseconds ();
      if (!write_scene_preview (
              dwg, preview_path, source_size, source_version,
              wipeout_frame, presentation_settings, &tables, &counts,
              &gpu_lines, &overview,
              &report->preview_size)
          || !create_preview_ready_file (preview_ready_path))
        {
          unlink (preview_path);
          unlink (preview_ready_path);
          report->preview_size = 0;
        }
      report->performance.preview_ms = milliseconds_from_nanoseconds (
          elapsed_nanoseconds (stage_started));
    }
  gpu_segment_count = gpu_lines.model_segments + gpu_lines.block_segments;
  if (gpu_segment_count > SCENE_OVERVIEW_SEGMENTS)
    {
      stage_started = monotonic_nanoseconds ();
      if (!build_spatial_segment_store (
              &writer, dwg, &tables, &overview, gpu_segment_count,
              &spatial, &report->performance))
        goto done;
      report->performance.spatial_index_ms
          = milliseconds_from_nanoseconds (
              elapsed_nanoseconds (stage_started));
    }

  descriptor
      = open (output_path,
              O_WRONLY | O_CREAT | O_EXCL | O_BINARY, 0600);
  if (descriptor < 0)
    {
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot create cache destination");
      goto done;
    }
  created = 1;
  file = fdopen (descriptor, "wb");
  if (!file)
    {
      close (descriptor);
      descriptor = -1;
      if (error_message && error_message_size)
        (void)snprintf (error_message, error_message_size,
                        "cannot open cache destination stream");
      goto done;
    }
  descriptor = -1;
  writer.file = file;
  body_offset = align_up (
      CACHE_HEADER_SIZE
          + (uint64_t)LIBREDWG_SCENE_SECTION_COUNT * DIRECTORY_ENTRY_SIZE,
      8);
  if (!seek_to (&writer, body_offset))
    {
      if (!writer.failed)
        set_error (&writer, "cannot initialize scene cache");
      goto done;
    }
  stage_started = monotonic_nanoseconds ();
  if (!write_section_groups (
          &writer, dwg, &tables, &counts, source_version,
          wipeout_frame, presentation_settings, &gpu_lines, &overview,
          &spatial,
          &hatch_fills, sections, &report->performance))
    {
      if (!writer.failed)
        set_error (&writer, "cannot write scene-cache sections");
      goto done;
    }
  report->performance.section_write_ms
      = milliseconds_from_nanoseconds (
          elapsed_nanoseconds (stage_started));
  stage_started = monotonic_nanoseconds ();
  if (!position (&writer, &file_size)
      || !write_header (
          &writer, file_size, source_size, source_version,
          (uint32_t)LIBREDWG_MAINTENANCE_VERSION (dwg), 0)
      || !write_directory (&writer, sections)
      || !flush_writer (&writer)
      || fflush (file) != 0)
    {
      if (!writer.failed)
        set_error (&writer, "cannot finalize scene cache");
      goto done;
    }
  if (fclose (file) != 0)
    {
      file = NULL;
      set_error (&writer, "cannot close scene cache");
      goto done;
    }
  file = NULL;
  report->performance.finalize_ms = milliseconds_from_nanoseconds (
      elapsed_nanoseconds (stage_started));
  report->cache_size = file_size;
  report->coverage = counts;
  report->gpu_lines = gpu_lines;
  report->hatch_fills = hatch_fills;
  for (i = 0; i < LIBREDWG_SCENE_SECTION_COUNT; i++)
    {
      if (sections[i].kind != SECTION_KINDS[i]
          || sections[i].record_size != SECTION_RECORD_SIZES[i])
        {
          if (error_message && error_message_size)
            (void)snprintf (error_message, error_message_size,
                            "scene-cache section order is inconsistent");
          goto done;
        }
      report->sections[i].name = SECTION_NAMES[i];
      report->sections[i].records = sections[i].record_count;
      report->sections[i].bytes = sections[i].byte_length;
    }
  success = 1;

done:
  if (file)
    fclose (file);
  if (descriptor >= 0)
    close (descriptor);
  if (!success && created)
    unlink (output_path);
  close_spatial_segment_store (&spatial);
  free_overview_plan (&overview);
  free_tables (&tables);
  return success;
}
