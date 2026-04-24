# Third-Party Licenses and Attributions

WordBrain bundles third-party data and code. Each item is listed with its
license and attribution.

## Frequency list — `src-tauri/assets/subtlex_us_freq.json`

- **Source:** [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords),
  `content/2018/en/en_full.txt`
- **License:** MIT
- **Upstream corpus:** OpenSubtitles 2018
- **Attribution:** Copyright (c) Hermit Dave, distributed under the MIT License.
  The underlying OpenSubtitles corpus is used under its community terms; please
  consult [opensubtitles.org](https://www.opensubtitles.org/) for corpus-level
  licensing.
- **Usage in WordBrain:** top-65,000 lowercase a-z lemmas (1–24 chars, with
  single-letter entries restricted to `a` and `i`), ranked by subtitle
  frequency. Used as a SUBTLEX-US substitute because SUBTLEX-US itself is
  distributed under CC-BY-NC-SA (non-commercial), whereas this list is MIT and
  derived from the same subtitle-corpus methodology as Brysbaert & New
  (2009) "Moving beyond Kučera and Francis" — the paper that defines SUBTLEX-US.

MIT License text:

```
Copyright (c) 2016 Hermit Dave

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
