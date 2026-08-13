// SPDX-License-Identifier: GPL-3.0-or-later

#include <dwg.h>

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_PROBE_ACIS_BLOCKS 1000000u

typedef struct
{
  uint64_t entities;
  uint64_t decoded_payload_bytes;
  uint64_t encoded_duplicate_bytes;
  uint64_t block_metadata_bytes;
} AcisAllocationSummary;

static int
add_u64 (uint64_t *target, uint64_t value)
{
  if (UINT64_MAX - *target < value)
    return 0;
  *target += value;
  return 1;
}

static const Dwg_Entity__3DSOLID *
acis_entity (const Dwg_Object *object)
{
  if (!object || !object->tio.entity)
    return NULL;
  if (object->fixedtype == DWG_TYPE_REGION)
    return object->tio.entity->tio.REGION;
  if (object->fixedtype == DWG_TYPE__3DSOLID)
    return object->tio.entity->tio._3DSOLID;
  if (object->fixedtype == DWG_TYPE_BODY)
    return object->tio.entity->tio.BODY;
  return NULL;
}

static int
summarize_acis_allocations (const Dwg_Data *dwg,
                            AcisAllocationSummary *summary)
{
  size_t object_index;
  memset (summary, 0, sizeof (*summary));
  for (object_index = 0; object_index < (size_t)dwg->num_objects;
       object_index++)
    {
      const Dwg_Entity__3DSOLID *solid
          = acis_entity (&dwg->object[object_index]);
      uint64_t decoded_bytes = 0;
      size_t block;
      if (!solid || !solid->acis_data || solid->acis_empty)
        continue;
      summary->entities++;
      if (solid->version > 1)
        decoded_bytes = (uint64_t)solid->sab_size;
      else
        {
          if ((uint64_t)solid->num_blocks > MAX_PROBE_ACIS_BLOCKS
              || (solid->num_blocks && !solid->block_size))
            return 0;
          for (block = 0; block < (size_t)solid->num_blocks; block++)
            {
              uint64_t length = (uint64_t)solid->block_size[block];
              if (!add_u64 (&decoded_bytes, length))
                return 0;
              if (solid->encr_sat_data
                  && solid->encr_sat_data[block]
                  && !add_u64 (&summary->encoded_duplicate_bytes,
                               length))
                return 0;
            }
          if (!add_u64 (
                  &summary->block_metadata_bytes,
                  (uint64_t)solid->num_blocks
                      * (sizeof (char *) + sizeof (BITCODE_BL))))
            return 0;
        }
      if (!add_u64 (&summary->decoded_payload_bytes, decoded_bytes))
        return 0;
    }
  return 1;
}

static int
parse_hold_seconds (const char *value, unsigned int *result)
{
  char *end = NULL;
  unsigned long parsed;

  errno = 0;
  parsed = strtoul (value, &end, 10);
  if (errno != 0 || end == value || *end != '\0'
      || parsed < 1ul || parsed > 300ul)
    return 0;
  *result = (unsigned int)parsed;
  return 1;
}

int
main (int argc, char **argv)
{
  Dwg_Data dwg;
  unsigned int error;
  unsigned int hold_seconds;
  uint64_t object_slot_bytes;
  uint64_t object_slot_slack_bytes;
  uint64_t entity_wrapper_bytes;
  uint64_t line_body_bytes = 0;
  uint64_t object_reference_bytes;
  uint64_t reference_pointer_bytes;
  uint64_t line_entities = 0;
  size_t object_index;
  AcisAllocationSummary acis;

  if (argc != 3 || !parse_hold_seconds (argv[2], &hold_seconds))
    {
      fputs ("usage: libredwg-object-graph-probe INPUT_DWG "
             "HOLD_SECONDS_1_TO_300\n", stderr);
      return 2;
    }

  memset (&dwg, 0, sizeof (dwg));
  dwg.opts = 0;
  error = (unsigned int)dwg_read_file (argv[1], &dwg);
  if (error >= DWG_ERR_CRITICAL || dwg.num_objects == 0)
    {
      fprintf (stderr, "LibreDWG parse failed (0x%x)\n", error);
      return 1;
    }

  object_slot_bytes
      = (uint64_t)dwg.num_alloced_objects * sizeof (Dwg_Object);
  object_slot_slack_bytes
      = (uint64_t)(dwg.num_alloced_objects - dwg.num_objects)
        * sizeof (Dwg_Object);
  entity_wrapper_bytes
      = (uint64_t)dwg.num_entities * sizeof (Dwg_Object_Entity);
  object_reference_bytes
      = (uint64_t)dwg.num_object_refs * sizeof (Dwg_Object_Ref);
  reference_pointer_bytes
      = (uint64_t)dwg.num_object_refs * sizeof (Dwg_Object_Ref *);
  for (object_index = 0; object_index < (size_t)dwg.num_objects;
       object_index++)
    if (dwg.object[object_index].fixedtype == DWG_TYPE_LINE)
      line_entities++;
  line_body_bytes = line_entities * sizeof (Dwg_Entity_LINE);
  if (!summarize_acis_allocations (&dwg, &acis))
    {
      fputs ("allocation summary overflow\n", stderr);
      return 1;
    }
  fputs ("{\"schema\":\"dwg-libredwg-object-graph-probe/1\"", stdout);
  printf (",\"objects\":%" PRIu64,
          (uint64_t)dwg.num_objects);
  printf (",\"allocated_object_slots\":%" PRIu64,
          (uint64_t)dwg.num_alloced_objects);
  printf (",\"entities\":%" PRIu64,
          (uint64_t)dwg.num_entities);
  printf (",\"object_references\":%" PRIu64,
          (uint64_t)dwg.num_object_refs);
  printf (",\"line_entities\":%" PRIu64, line_entities);
  printf (",\"sizes\":{\"dwg_object\":%zu", sizeof (Dwg_Object));
  printf (",\"entity_wrapper\":%zu", sizeof (Dwg_Object_Entity));
  printf (",\"line_body\":%zu", sizeof (Dwg_Entity_LINE));
  printf (",\"object_reference\":%zu", sizeof (Dwg_Object_Ref));
  printf (",\"pointer\":%zu}", sizeof (void *));
  printf (",\"derived_bytes\":{\"object_slots\":%" PRIu64,
          object_slot_bytes);
  printf (",\"object_slot_slack\":%" PRIu64,
          object_slot_slack_bytes);
  printf (",\"entity_wrappers\":%" PRIu64,
          entity_wrapper_bytes);
  printf (",\"line_bodies\":%" PRIu64, line_body_bytes);
  printf (",\"object_reference_records\":%" PRIu64,
          object_reference_bytes);
  printf (",\"reference_pointer_vector\":%" PRIu64 "}",
          reference_pointer_bytes);
  printf (",\"acis\":{\"entities\":%" PRIu64,
          acis.entities);
  printf (",\"decoded_payload_bytes\":%" PRIu64,
          acis.decoded_payload_bytes);
  printf (",\"encoded_duplicate_bytes\":%" PRIu64,
          acis.encoded_duplicate_bytes);
  printf (",\"block_metadata_bytes\":%" PRIu64 "}",
          acis.block_metadata_bytes);
  fputs (",\"retained_decode_buffers\":{"
         "\"source_file\":false,"
         "\"generic_decompressed_sections\":false}", stdout);
  printf (",\"hold_seconds\":%u}\n", hold_seconds);
  if (fflush (stdout) != 0)
    return 1;

  sleep (hold_seconds);
  return 0;
}
