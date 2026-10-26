# Test plan and results

## Plan

- Reject invalid extensions, unknown operations, and out-of-range widths.
- Preserve pre-existing output files.
- Fail clearly when Inkscape is missing and remove only newly reserved output.
- With actual Inkscape installed, render sample.svg to a new 640-wide PNG; check
  signature, IHDR dimensions, and visual output.
- Test the installed package outside the checkout.

## Results

The automated tests cover argument errors, existing-file preservation, and a
missing executable. Live rendering has not been run because this environment
does not contain Inkscape. No synthetic renderer is substituted.
