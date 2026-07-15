# Course data catalog

`courses/` is the canonical, Agent-managed course catalog.  Each course has a
stable kebab-case directory ID and follows this package layout:

```text
courses/<course-id>/
├── course.json
├── index.json
└── points/
    └── <point-id>.json
```

`index.json` holds the forest-ready cluster metadata and lightweight point
metadata.  Each point file carries the same lightweight fields plus its full
learning content.  Keep those duplicated fields synchronized for new edits.

The first package is seeded from `D:\Project\AI_tree_course` with:

```powershell
python .\scripts\import_ai_tree_course.py
```

The importer treats the source project as read-only, copies its published
`index.json` and point files byte-for-byte, reports legacy compatibility notes
without normalizing them, and refuses to overwrite an existing package without
`--force`.
