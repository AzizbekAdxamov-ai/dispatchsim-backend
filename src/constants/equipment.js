// Single source of truth for equipment type KEYS on the backend — mirrors
// constants/roles.js. These are the exact strings stored in `loads.equipment_type`
// (see migration 007's `loads_equipment` CHECK) and validated on the way in.
//
// Human-readable labels/icons for these keys live only in
// frontend/src/data/equipmentTypes.js (the frontend's own single source of
// truth per CLAUDE.md's "equipmentType — har doim kalit" rule) — the
// backend cannot import that file (it's a separate frontend package), so
// this list is kept in sync with it by convention, the same way ROLE_KEYS
// is kept in sync with the frontend's role labels.
export const EQUIPMENT_KEYS = ['dry-van', 'reefer', 'flatbed', 'step-deck', 'tanker', 'power-only']
