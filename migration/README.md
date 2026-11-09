
## Converter (Nov 2026)
`convert.py` reads the CSV export and uploads it through `/api/admin/migrate` (operator secret). Repeatable — rerun after a newer export.
```
python3 convert.py --export ./export --out ./out                                   # convert + summary only
python3 convert.py --export ./export --upload https://suqa-dev.netlify.app --shop <slug> --secret <SUQA_EVENTS_SECRET> --dry-run
python3 convert.py --export ./export --upload https://suqa-dev.netlify.app --shop <slug> --secret <SUQA_EVENTS_SECRET>
```
`--used-only` limits products to items with stock or sales/purchase history (skips the "modified in the last 2 years" rule).
