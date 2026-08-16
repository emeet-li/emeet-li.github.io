# PR Trace Map

Each pull request is a **process sequence**. Pairwise process distance is sequence-edit (normalized Levenshtein on the collapsed event trace) plus cosine distance of the transition profile. **MDS** places PRs in 2D so nearby dots are similar processes. **Time is the vertical axis.** A dot appears when the PR is created and leaves a trace until `closed` / `merged` / `head_ref_deleted`. Press **Start** to play the traces into existence.

## Run

```bash
cd ~/Desktop/3Dprocess
python3 -m http.server 8001
```

Open http://localhost:8001/

## Use

1. **Upload CSV** or **Load sample**.
2. Confirm entity (`pr_number`) and event column. Keep GitHub PR timeline on to cut each sequence at a terminal event.
3. Press **Start**. Dots appear at creation time and grow upward until the PR ends.

Color is creation time, or outcome (merged / closed / deleted / open).

## Acknowledgement 

1, https://github.com/dora-ljh/literati-circle-graph for asthetics.
2. vibe coding.
