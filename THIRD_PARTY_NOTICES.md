# Third-party notices

Nothing but the Gladys SDK is installed at runtime. Parts of this
integration are a JavaScript port of the work below.

## pydexcom

pydexcom 0.5.1 (<https://github.com/gagebenne/pydexcom>, read at the tag
`0.5.1`, commit `696cc9c`), an unofficial Python client of the Dexcom Share
API, under the MIT License. Ported to JavaScript in `src/dexcom/`: the
regions, their hosts and application ids (`const.py`), the three endpoints
and their bodies and query (`dexcom.py`), how the error body of the API is
read (`_handle_error_code`, `errors.py`), the all-zero id seen as a failure,
one new session when the session is refused, how a reading is read (its
`DT` date, its value, the trend directions and arrows:
`glucose_reading.py`, `const.py`), and the shapes of its recorded test
answers used with made-up values in `test/`.

```
MIT License
Copyright (c) 2023 Gage Benne
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

Dexcom, Dexcom G6, Dexcom G7, Dexcom ONE+ and Dexcom Share are trademarks
of Dexcom, Inc.; this integration is unofficial and not affiliated with
Dexcom.

## LM1LC3N7/gladys-librelinkup

The structure of the app (start queue, epochs of the loop, stops kept as a
salted HMAC in `/data`, one forced attempt per series, bounded pauses kept
in `/data`, state budget, transport badges, never a smaller device, the
"once per crossing" and "once per threshold" triggers), the HTTP transport
and the test helpers follow this integration of the same author, under the
Apache License 2.0 of this repository.
