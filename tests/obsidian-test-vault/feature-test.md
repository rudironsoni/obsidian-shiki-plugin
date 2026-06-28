# Feature test

Inline code `{ts} const inlineValue: number = 2` should render.

~~~ts title="Startup check" showLineNumbers {1}
const x: number = 1;
console.log(x);
~~~

~~~diff
- old line
+ new line
~~~

~~~odin
package main
~~~

```cs
List<int[]> intervals = [[1, 3], [2, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597], [2584, 4181], [6765, 10946], [17711, 28657], [46368, 75025], [121393, 196418], [317811, 514229]];
var startIndex = 0;
intervals.Sort((a, b) => a[startIndex] - b[startIndex]);
```
