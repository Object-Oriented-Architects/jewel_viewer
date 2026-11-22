namespace JewelViewer;

internal static class StoneRules
{
    public const string SmoothKey = "jewelviewer.smooth";
    private static readonly string[] Truthy = { "1", "true", "yes" };

    public static bool Smooth(byte kind, IEnumerable<string?> pathTags) =>
        kind == 2 && pathTags.Any(tag => Truthy.Contains(tag?.Trim(), StringComparer.OrdinalIgnoreCase));
}
