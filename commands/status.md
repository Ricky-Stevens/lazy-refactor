---
name: status
description: Show current scan and fix state
---

# Status Command

Display the current state of code quality scans and fixes.

## Usage

```
/lazy-refactor status
```

## Behavior

1. **Fetch summary**: Call `get_summary` to retrieve overall statistics about findings.

2. **Display state**:
   - **Total findings**: Count of all stored findings
   - **By status**: Breakdown of open, fixed, and dismissed findings
   - **By severity**: Count at each level (critical, high, medium, low)
   - **By category**: Count in each category (duplicates, dead-code, metrics, patterns, modularity, comments, over-engineering)

3. **Show timing**:
   - Last scan timestamp
   - Last fix timestamp (if any fixes have been applied)
   - Time since last scan

4. **Provide quick actions**:
   - Suggest running `/lazy-refactor scan` if no recent scans
   - Suggest running `/lazy-refactor fix critical` if critical findings exist
   - Suggest running `/lazy-refactor report --severity=high` to see high-severity findings

## Examples

```
/lazy-refactor status
```
