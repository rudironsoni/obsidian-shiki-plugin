# Merge Intervals

```csharp showLineNumbers
List<int[]> intervals = [[1, 3], [2, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597]];
List<int[]> expectedResult = [[1, 6], [8, 10], [15, 18], [21, 34], [55, 89], [144, 233], [377, 610], [987, 1597]];

// Define constants for start and end indices
var startIndex = 0;
var endIndex = 1;

// Sort the intervals based on their start values
intervals.Sort((a, b) => a[startIndex] - b[startIndex]);

// Initialize an array to store the merged intervals
List<int[]> mergedIntervals = new();

// Initialize variables to track the current merged interval
var mergeStart = intervals[0][startIndex];
var mergeEnd = intervals[0][endIndex];

// Iterate through the intervals
for (int i = 0; i < intervals.Count; i++) {
    var subsequentInterval = intervals[i];
    if (subsequentInterval[startIndex] <= mergeEnd) {
        // If the current interval overlaps with the current merged interval, update the merge end
        mergeEnd = Math.Max(mergeEnd, subsequentInterval[endIndex]);
    } else {
        // If the current interval does not overlap, add the current merged interval to the result and start a new one
        mergedIntervals.Add([mergeStart, mergeEnd]);
        mergeStart = subsequentInterval[startIndex];
        mergeEnd = subsequentInterval[endIndex];
    }
}

// Add the last merged interval to the result
mergedIntervals.Add([mergeStart, mergeEnd]);
mergedIntervals.ForEach(interval => Console.WriteLine($"[{interval[0]}, {interval[1]}]"));
```
