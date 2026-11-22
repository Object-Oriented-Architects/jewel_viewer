using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace JewelViewer;

internal enum MaterialSource { Layer, Object, Parent }
internal enum MaterialEvent { Changed, Added, Deleted, Replaced }
internal enum MaterialUpdate { Ignore, Metadata, Dirty }

internal static class MaterialRules
{
    // Rhino 8의 GemMaterialGuid는 다른 타입을 가리키므로 실제 Gem 타입 id를 쓴다.
    public static readonly Guid GemType = new("5386a427-85bb-48a8-82a8-109ff01927c3");

    public static Guid Resolve(
        MaterialSource source, int objectIndex, int layerIndex, Guid? parent, Func<int, Guid> lookup)
    {
        if (source == MaterialSource.Parent && parent.HasValue)
            return parent.Value;
        var index = source == MaterialSource.Object ? objectIndex : layerIndex;
        return index < 0 ? Guid.Empty : lookup(index);
    }

    public static MaterialDescriptor? Read(
        Guid id, ISet<Guid> references, Func<Guid, MaterialDescriptor?> find)
    {
        // Find 실패 id도 보존해야 삭제 후 Undo·추가 때 이 인스턴스를 다시 찾는다.
        references.Add(id);
        return find(id);
    }

    public static byte Kind(Guid type) => type == GemType ? (byte)2 : (byte)1;

    public static string TextureId(byte[] image) => Convert.ToHexString(SHA256.HashData(image)).ToLowerInvariant();

    public static bool BrowserImage(ReadOnlySpan<byte> image) =>
        image.StartsWith(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }) ||
        image.StartsWith(new byte[] { 0xFF, 0xD8, 0xFF }) ||
        image.StartsWith("GIF8"u8) ||
        image.StartsWith("BM"u8) ||
        (image.Length >= 12 && image.StartsWith("RIFF"u8) && image[8..12].SequenceEqual("WEBP"u8));

    public static bool KindChanged(MaterialDescriptor? before, MaterialDescriptor? after) =>
        (before?.Kind ?? 0) != (after?.Kind ?? 0);

    public static MaterialUpdate EventImpact(
        MaterialDescriptor? before, MaterialDescriptor? after, MaterialEvent change, bool topLevel,
        bool ignoreContext = false)
    {
        if (ignoreContext)
            return MaterialUpdate.Ignore;
        if (topLevel && change != MaterialEvent.Changed)
            return MaterialUpdate.Dirty;
        if (before == after)
            return MaterialUpdate.Ignore;
        return KindChanged(before, after) ? MaterialUpdate.Dirty : MaterialUpdate.Metadata;
    }
}

internal sealed record MaterialDescriptor
{
    public byte Kind { get; private init; }
    public Vec3 Color { get; private init; }
    public double Metallic { get; private init; }
    public double Roughness { get; private init; }
    public double Ior { get; private init; }
    public double Opacity { get; private init; }
    public double Clearcoat { get; private init; }
    public double ClearcoatRoughness { get; private init; }
    public ColorMap? ColorMap { get; private init; }

    private MaterialDescriptor() { }

    public static MaterialDescriptor Create(
        byte kind, Vec3 color, double metallic = 0, double roughness = 0.5, double ior = 1.5,
        double opacity = 1, double clearcoat = 0, double clearcoatRoughness = 0, ColorMap? colorMap = null)
    {
        static double Unit(double value, double fallback) =>
            double.IsFinite(value) ? Math.Clamp(value, 0, 1) : fallback;
        return new()
        {
            Kind = kind,
            Color = new(Unit(color.X, 1), Unit(color.Y, 1), Unit(color.Z, 1)),
            Metallic = Unit(metallic, 0),
            Roughness = Unit(roughness, 0.5),
            Ior = double.IsFinite(ior) ? Math.Max(1, ior) : 1.5,
            Opacity = Unit(opacity, 1),
            Clearcoat = Unit(clearcoat, 0),
            ClearcoatRoughness = Unit(clearcoatRoughness, 0),
            ColorMap = colorMap?.Transform.Array.All(double.IsFinite) == true ? colorMap : null
        };
    }

    public MaterialJson Json => new(
        Kind, Color.Array, Metallic, Roughness, Ior, Opacity, Clearcoat, ClearcoatRoughness,
        ColorMap == null ? null : new(ColorMap.Texture, ColorMap.Transform.Array));
}

/// <summary>Rhino UvwTransform의 u·v 행(반복·오프셋·회전)이다. w 성분은 0으로 본다.</summary>
internal readonly record struct UvTransform(double M00, double M01, double M03, double M10, double M11, double M13)
{
    public double[] Array => new[] { M00, M01, M03, M10, M11, M13 };
}

internal sealed record ColorMap(string Texture, UvTransform Transform);

internal sealed record MaterialJson(
    [property: JsonPropertyName("kind")] byte Kind,
    [property: JsonPropertyName("color")] double[] Color,
    [property: JsonPropertyName("metallic")] double Metallic,
    [property: JsonPropertyName("roughness")] double Roughness,
    [property: JsonPropertyName("ior")] double Ior,
    [property: JsonPropertyName("opacity")] double Opacity,
    [property: JsonPropertyName("clearcoat")] double Clearcoat,
    [property: JsonPropertyName("clearcoatRoughness")] double ClearcoatRoughness,
    [property: JsonPropertyName("colorMap")] ColorMapJson? ColorMap);

internal sealed record ColorMapJson(
    [property: JsonPropertyName("texture")] string Texture,
    [property: JsonPropertyName("transform")] double[] Transform);

internal sealed class MaterialReferences
{
    private readonly Dictionary<Guid, HashSet<Guid>> _objects = new();

    public void Set(Guid obj, IEnumerable<Guid> references) =>
        _objects[obj] = references.Where(id => id != Guid.Empty).ToHashSet();

    public Guid[] Affected(ISet<Guid> materials) =>
        _objects.Where(pair => pair.Value.Overlaps(materials)).Select(pair => pair.Key).ToArray();

    public string[] Textures(IReadOnlyDictionary<Guid, MaterialDescriptor> table)
    {
        var referenced = _objects.Values.SelectMany(materials => materials).ToHashSet();
        return table.Where(pair => referenced.Contains(pair.Key)).Select(pair => pair.Value.ColorMap?.Texture)
            .OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
    }

    public void Remove(Guid obj) => _objects.Remove(obj);
    public void Clear() => _objects.Clear();
}
