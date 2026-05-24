# Regulations Rule Vocabulary

Canonical `rule_type` values and `value` JSONB shapes for `state_regulation_rules`.

When adding a new rule_type, document the canonical payload shape here.

## Core vocabulary

### `weapon_legal`
Is this weapon legal for this species/season?
```json
{ "legal": true, "method": "rifle", "restrictions": [] }
{ "legal": false, "method": "rifle", "reason": "shotgun-only state" }
```

### `caliber_min`
Minimum caliber for legal harvest of a species.
```json
{
  "min_caliber": ".22",
  "centerfire_required": true,
  "min_bullet_grain": 50,
  "min_muzzle_energy_ftlbs": 500
}
```

### `magazine_limit`
Max rounds allowed in magazine for the weapon used.
```json
{ "max_rounds": 5, "applies_to": "rifle", "exceptions": [] }
{ "max_rounds": 3, "applies_to": "shotgun", "context": "waterfowl plug" }
```

### `shot_size_max`
Largest shot size legal for waterfowl/upland species.
```json
{ "max_shot": "T", "applies_to": "waterfowl", "non_toxic_only": true }
{ "max_shot": "BB", "applies_to": "upland_game" }
```

### `non_toxic_shot_required`
Non-toxic (steel/bismuth/tungsten) shot required.
```json
{
  "required": true,
  "applies_to": ["waterfowl", "doves_on_public_land"],
  "exceptions": ["upland game on private land"]
}
```

### `plug_required`
Shotgun plug required to limit magazine capacity.
```json
{ "required": true, "max_total_rounds": 3, "applies_to": "waterfowl" }
```

### `orange_minimum`
Blaze orange clothing requirement.
```json
{
  "required": true,
  "color": "blaze_orange_or_fluorescent_pink",
  "min_sq_inches": 400,
  "head_required": true,
  "applies_to": ["firearm_seasons", "muzzleloader_seasons"],
  "exempt_seasons": ["archery"]
}
```

### `crossbow_during_archery`
Can a crossbow be used during archery-only season?
```json
{ "legal": true, "all_hunters": true }
{ "legal": true, "only": ["seniors", "disabled"] }
{ "legal": false }
```

### `baiting_legal`
Is hunting over bait legal?
```json
{ "legal": true, "applies_to": ["bear"], "restrictions": ["state-licensed bait sites only"] }
{ "legal": false, "applies_to": ["deer"], "reason": "CWD prevention" }
```

### `hounding_legal`
Are dogs/hounds legal for pursuit?
```json
{ "legal": true, "applies_to": ["bear", "mountain_lion"], "season_dates": "Sep 15 - Oct 31" }
{ "legal": false }
```

### `night_hunting_legal`
Legal to hunt at night?
```json
{ "legal": true, "applies_to": ["raccoon", "coyote", "feral_hog"], "with_artificial_light": true }
```

### `sunday_hunting_legal`
Sunday hunting allowed?
```json
{ "legal": true, "restrictions": [] }
{ "legal": true, "restrictions": ["private land only", "no firearm before 12pm"] }
{ "legal": false, "exceptions": ["fox hunting", "raccoon hunting"] }
```

### `antler_restriction`
Antler-point requirement for legal harvest.
```json
{
  "required": true,
  "min_points_one_side": 4,
  "applies_to": ["whitetail"],
  "min_spread_inches": null,
  "exempt": ["youth_hunters", "first_buck_in_lifetime"]
}
```

### `cwd_carcass_transport`
Restrictions on transporting carcasses out of CWD-positive zones.
```json
{
  "restricted": true,
  "out_of_cwd_zone_parts_allowed": ["boned_meat", "antlers_no_tissue", "hides_no_head"],
  "out_of_state_parts_allowed": ["quartered_meat_no_spine", "skull_cap_cleaned", "hides"],
  "applies_to": ["whitetail", "mule_deer", "elk"]
}
```

### `cwd_testing_required`
Mandatory CWD sample submission?
```json
{ "required": true, "applies_to": ["whitetail in WMUs 2A,2B,2C"], "delivery": "mail-in kit or check station" }
```

### `bag_limit_daily`
Daily bag limit per hunter.
```json
{ "limit": 6, "species": "dove", "modifier": "aggregate" }
{ "limit": 1, "species": "buck", "modifier": "per season" }
```

### `bag_limit_season`
Season aggregate per hunter.
```json
{ "limit": 3, "species": "deer", "breakdown": { "antlered": 1, "antlerless": 2 } }
```

### `bag_limit_lifetime`
Once-in-a-lifetime rule (sheep/moose/goat/bison).
```json
{ "limit": 1, "species": "rocky_mountain_bighorn", "lifetime": true }
```

### `season_dates`
Specific season start/end (for cases where it's a rule rather than a season row).
```json
{ "start_month_day": "11-15", "end_month_day": "11-30", "year_round": false }
```

### `mandatory_check_station`
Must report harvest at a physical check station.
```json
{ "required": true, "applies_to": ["bear", "elk"], "hours": "harvest +24h", "method": "physical check" }
```

### `mandatory_harvest_report`
Must submit electronic harvest report.
```json
{ "required": true, "applies_to": ["all big game"], "method": "online or call-in", "deadline_days": 14 }
```

### `nonresident_cap_pct`
Cap on nonresident tag allocation as a percentage.
```json
{ "cap_pct": 10, "applies_to": ["bighorn_sheep"], "rationale": "10% NR cap" }
```

### `application_deadline`
Annual application deadline.
```json
{ "month_day": "05-31", "species": "elk", "type": "primary draw" }
```

### `refund_deadline`
Last day to refund a drawn tag.
```json
{ "month_day": "08-01", "species": "all", "refund_pct": 80 }
```

### `arrow_specs`
Arrow specifications for legal archery.
```json
{
  "min_arrow_length_inches": 28,
  "min_arrow_weight_grains": 400,
  "broadhead_required": true,
  "broadhead_min_cut_diameter_inches": 0.875,
  "broadhead_mechanical_allowed": true
}
```

### `youth_hunter_age`
Age threshold for youth hunter privileges.
```json
{ "max_youth_age": 16, "privileges": ["earlier seasons", "any-sex tags"] }
```

### `party_hunting_allowed`
Can a hunter's tag be used by another in the party?
```json
{ "legal": true, "restrictions": ["both hunters present", "both have valid license"] }
{ "legal": false }
```

### `dog_chase_season`
Training season for chase-only (no harvest).
```json
{ "season_dates": "Jul 1 - Aug 31", "species": "bear", "harvest_allowed": false }
```

## Adding a new rule_type

1. Define the canonical JSON shape here.
2. Use lowercase snake_case for the rule_type identifier.
3. Use nullable `species_id` for state-wide rules (e.g. statewide non-toxic shot rule), specific species id for species-targeted rules.
4. Set `zone_scope` to `"statewide"` unless the rule is zone/unit/county specific.
5. Always populate `effective_year` and `source_url` for citation.
