# lazy-refactor — Rule Examples by Language

This document provides concrete examples of what each rule looks like per language, so the implementing LLM understands the exact patterns to detect.

---

## Common Rules (all languages)

### Hardcoded Magic Values
```js
// DETECT: numeric literals in logic (excluding 0, 1, -1)
{
  id: 'magic-number',
  pattern: /(?<![a-zA-Z_])\b(?!0\b|1\b|-1\b)\d{2,}\b/,
  // Refine: skip constants declarations, enum values, array indices
}

// DETECT: repeated string literals (same string 3+ times across files)
// Implementation: build frequency map of string literals, flag those appearing 3+
```

### Long Files
```js
{
  id: 'long-file',
  // Implementation: wc -l, flag files above threshold
  threshold: 300, // configurable
}
```

---

## TypeScript / JavaScript Rules

### Empty Catch Blocks
```
// DETECT
catch (e) {}
catch (error) { }
catch (_) {}

// ALSO DETECT (logging-only catch)
catch (e) { console.log(e); }
catch (error) { console.error(error); }

// DO NOT FLAG
catch (e) { throw new CustomError(e); }
catch (e) { handleError(e); }
catch (e) { logger.error('Failed to process', { error: e }); }
```

Regex: `catch\s*\([^)]*\)\s*\{\s*(console\.(log|error|warn)\([^)]*\)\s*;?\s*)?\}`

### Debugging Leftovers
```
// DETECT
console.log('debug', data);
console.debug(result);
console.info('here');
debugger;

// DO NOT FLAG (in test files)
// DO NOT FLAG (in logging utility files)
// DO NOT FLAG: console.error in catch blocks (that's error handling, not debugging)
```

Regex: `console\.(log|debug|info)\s*\(` and `\bdebugger\b;`

Exclusions: `*.test.*`, `*.spec.*`, files containing 'logger' or 'logging' in path

### Full Library Imports
```
// DETECT
import _ from 'lodash';
import lodash from 'lodash';
import Rx from 'rxjs';
import moment from 'moment';

// DO NOT FLAG
import { debounce } from 'lodash';
import { Observable } from 'rxjs';
import dayjs from 'dayjs';  // dayjs is designed for default import
```

Known heavy libraries to flag: lodash, rxjs, ramda, underscore, date-fns (when importing all)

### Missing useEffect Cleanup
```
// DETECT: useEffect with subscription/timer but no return
useEffect(() => {
  const interval = setInterval(doThing, 1000);
}, []);

useEffect(() => {
  window.addEventListener('resize', handler);
}, []);

// DO NOT FLAG
useEffect(() => {
  const interval = setInterval(doThing, 1000);
  return () => clearInterval(interval);
}, []);
```

Heuristic: useEffect containing `setInterval`, `setTimeout`, `addEventListener`, `subscribe` without a `return` statement.

### Promise Chain Without Error Handling
```
// DETECT
fetch('/api/data').then(r => r.json()).then(setData);
axios.get('/users').then(handleResponse);

// DO NOT FLAG
fetch('/api/data').then(r => r.json()).then(setData).catch(handleError);
try { await fetch('/api/data'); } catch (e) { ... }
```

### `any` Type Usage
```
// DETECT
function process(data: any) { ... }
const result = value as any;
const items: any[] = [];

// DO NOT FLAG
// @ts-expect-error — known issue with library types
const result = value as any;  // (flagged but at lower severity if comment justifies)
```

### @ts-ignore / @ts-expect-error
```
// DETECT
// @ts-ignore
// @ts-expect-error
// @ts-nocheck
```

Count per file. More than 2-3 is a smell.

---

## Go Rules

### Discarded Errors
```
// DETECT
_ = json.Unmarshal(data, &result)
_ = os.Remove(filepath)
_, _ = fmt.Fprintf(w, template)
result, _ := strconv.Atoi(input)

// DO NOT FLAG (common acceptable discards)
_ = conn.Close()       // close errors are often intentionally ignored
defer file.Close()     // defer close without error check is common Go idiom
```

Regex: `_\s*[:=]=?\s*\w+\.\w+\(` — captures both `_ =` and `_ :=` patterns.

Refinement: maintain a list of commonly-acceptable discards (Close, Flush on defer).

### Debugging Leftovers
```
// DETECT
fmt.Println("debug:", value)
fmt.Printf("here: %v\n", data)
log.Println("got here")
spew.Dump(object)

// DO NOT FLAG
// In main.go or cmd/ files (may be intentional CLI output)
// In files that import a structured logging library (zap, logrus, slog)
```

Regex: `fmt\.Print(ln|f)?\s*\(` and `spew\.Dump\(`

Heuristic: if file imports `log/slog`, `go.uber.org/zap`, or `github.com/sirupsen/logrus`, raw `fmt.Print` is likely a debugging leftover.

### Empty Error Handling
```
// DETECT
if err != nil {
    return nil
}

if err != nil {
    return err  // bare return without wrapping — not necessarily wrong but flag if pattern is inconsistent
}

// DO NOT FLAG
if err != nil {
    return fmt.Errorf("failed to process %s: %w", name, err)
}
if err != nil {
    return nil, errors.Wrap(err, "processing failed")
}
```

### Deprecated ioutil Usage
```
// DETECT (deprecated since Go 1.16)
ioutil.ReadFile(path)
ioutil.ReadAll(reader)
ioutil.TempDir(dir, prefix)
ioutil.WriteFile(path, data, perm)

// SUGGEST
os.ReadFile(path)
io.ReadAll(reader)
os.MkdirTemp(dir, prefix)
os.WriteFile(path, data, perm)
```

---

## Python Rules

### Bare Except / Swallowed Errors
```
# DETECT
except:
    pass

except Exception:
    pass

except Exception as e:
    print(e)

# DO NOT FLAG
except ValueError as e:
    logger.error(f"Invalid input: {e}")
    raise
except (IOError, OSError) as e:
    handle_file_error(e)
```

Regex: `except\s*(?:Exception\s*)?(?:as\s+\w+\s*)?:\s*\n\s+(pass|print\()` (multi-line)

### Debugging Leftovers
```
# DETECT
print("debug", value)
print(f"here: {data}")
import pdb; pdb.set_trace()
breakpoint()
import ipdb; ipdb.set_trace()

# DO NOT FLAG
# In __main__ blocks
# In files with 'cli' or 'command' in the path
# In files that use click/typer/argparse (CLI tools)
```

### Missing Context Manager
```
# DETECT
f = open('file.txt', 'r')
data = f.read()
f.close()

# DO NOT FLAG
with open('file.txt', 'r') as f:
    data = f.read()
```

Regex: `(?<!with\s)open\s*\(` — matches `open(` not preceded by `with `.

### Old-Style String Formatting
```
# DETECT
"Hello %s, you have %d items" % (name, count)
"Hello {0}, you have {1} items".format(name, count)

# SUGGEST
f"Hello {name}, you have {count} items"
```

### os.path vs pathlib
```
# DETECT
os.path.join(base, filename)
os.path.exists(filepath)
os.path.dirname(path)

# SUGGEST
Path(base) / filename
Path(filepath).exists()
Path(path).parent
```

---

## C# Rules

### Empty Catch Blocks
```
// DETECT
catch (Exception ex) { }
catch { }
catch (Exception) { }
catch (Exception ex) { Console.WriteLine(ex); }

// DO NOT FLAG
catch (Exception ex) { _logger.LogError(ex, "Failed"); throw; }
catch (Exception ex) when (ex is OperationCanceledException) { }
```

### Debugging Leftovers
```
// DETECT
Console.WriteLine("debug: " + value);
Debug.WriteLine(data);
Debugger.Break();
System.Diagnostics.Debug.WriteLine(info);

// DO NOT FLAG
// In Program.cs of console applications
// In files using ILogger
```

### Deprecated Patterns
```
// DETECT
WebClient client = new WebClient();           // → HttpClient
Thread.Sleep(1000);                           // → await Task.Delay(1000) in async context
new Thread(() => DoWork()).Start();            // → Task.Run(() => DoWork())

// DETECT (old async pattern)
IAsyncResult result = BeginOperation();       // → async/await
```

### Missing Disposal
```
// DETECT
var stream = new FileStream(path, FileMode.Open);
// ... use stream ...
stream.Close();

// SUGGEST
using var stream = new FileStream(path, FileMode.Open);
// or
using (var stream = new FileStream(path, FileMode.Open))
{
    // ... use stream ...
}
```

---

## Java Rules

### Empty Catch Blocks
```
// DETECT
catch (Exception e) { }
catch (IOException e) { }
catch (Exception e) { e.printStackTrace(); }
catch (Exception e) { System.out.println(e); }

// DO NOT FLAG
catch (Exception e) { logger.error("Failed to process", e); throw; }
catch (InterruptedException e) { Thread.currentThread().interrupt(); }
```

### Debugging Leftovers
```
// DETECT
System.out.println("debug: " + value);
System.err.println(data);
e.printStackTrace();

// DO NOT FLAG
// In main() methods
// In files using SLF4J, Log4j, java.util.logging
```

### Deprecated Collections
```
// DETECT
Vector<String> items = new Vector<>();        // → ArrayList
Hashtable<K,V> map = new Hashtable<>();       // → HashMap or ConcurrentHashMap
Stack<T> stack = new Stack<>();               // → Deque (ArrayDeque)
StringBuffer sb = new StringBuffer();         // → StringBuilder (in single-threaded context)

// DETECT (old date/time)
Date now = new Date();                        // → Instant.now() or LocalDateTime.now()
Calendar cal = Calendar.getInstance();        // → LocalDate, LocalDateTime
SimpleDateFormat sdf = new SimpleDateFormat();// → DateTimeFormatter
```

### Missing Try-With-Resources
```
// DETECT
BufferedReader reader = new BufferedReader(new FileReader(path));
// ... use reader ...
reader.close();

// SUGGEST
try (BufferedReader reader = new BufferedReader(new FileReader(path))) {
    // ... use reader ...
}
```
