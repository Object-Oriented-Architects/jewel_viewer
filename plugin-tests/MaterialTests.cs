using System.Diagnostics;
using System.Text.Json;
using JewelViewer;

internal static partial class Program
{
    private static readonly Guid TestMaterial = new("00112233-4455-6677-8899-aabbccddeeff");
    private static readonly Guid TexturedMaterial = new("ffeeddcc-bbaa-9988-7766-554433221100");
    private static readonly byte[] TestTexture = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3 };
    private static readonly string TestTextureId = MaterialRules.TextureId(TestTexture);
    private static readonly UvTransform RhinoRepeatOffset = new(2, 0, -0.2, 0, 3, -0.6);

    private static Dictionary<Guid, MaterialDescriptor> TestMaterials() => new()
    {
        [TestMaterial] = MaterialDescriptor.Create(2, new(0.878, 0.067, 0.373), ior: 1.76, opacity: 0),
        [TexturedMaterial] = MaterialDescriptor.Create(1, new(0.2, 0.4, 0.8),
            colorMap: new(TestTextureId, RhinoRepeatOffset))
    };

    private static Dictionary<string, byte[]> TestTextures() => new() { [TestTextureId] = TestTexture };

    private static void MaterialResolution()
    {
        var objectMaterial = Guid.NewGuid();
        var layerMaterial = Guid.NewGuid();
        var parentMaterial = Guid.NewGuid();
        Guid Lookup(int index) => index == 3 ? objectMaterial : index == 4 ? layerMaterial : Guid.Empty;
        Equal(objectMaterial, MaterialRules.Resolve(MaterialSource.Object, 3, 4, parentMaterial, Lookup));
        Equal(layerMaterial, MaterialRules.Resolve(MaterialSource.Layer, 3, 4, parentMaterial, Lookup));
        Equal(parentMaterial, MaterialRules.Resolve(MaterialSource.Parent, 3, 4, parentMaterial, Lookup));
        Equal(layerMaterial, MaterialRules.Resolve(MaterialSource.Parent, 3, 4, null, Lookup));
        Equal(Guid.Empty, MaterialRules.Resolve(MaterialSource.Object, -1, 4, parentMaterial, Lookup));
        Equal(Guid.Empty, MaterialRules.Resolve(MaterialSource.Layer, 3, -1, parentMaterial, Lookup));
        // 부모의 재질 없음도 상속하며 자식 레이어로 되돌아가지 않는다.
        Equal(Guid.Empty, MaterialRules.Resolve(MaterialSource.Parent, 3, 4, Guid.Empty, Lookup));
        var outer = MaterialRules.Resolve(MaterialSource.Object, 3, 4, null, Lookup);
        var inner = MaterialRules.Resolve(MaterialSource.Parent, -1, 4, outer, Lookup);
        Equal(objectMaterial, MaterialRules.Resolve(MaterialSource.Parent, -1, 4, inner, Lookup));
        Equal(layerMaterial, MaterialRules.Resolve(MaterialSource.Layer, -1, 4, inner, Lookup));
        Equal(Guid.Empty, MaterialRules.Resolve(MaterialSource.Object, 999, 4, inner, Lookup));
    }

    private static void MaterialImpact()
    {
        var references = new MaterialReferences();
        var top = Guid.NewGuid();
        var other = Guid.NewGuid();
        var missing = Guid.NewGuid();
        var replacement = Guid.NewGuid();
        var available = TestMaterials();
        var read = new HashSet<Guid>();
        Equal<MaterialDescriptor?>(null, MaterialRules.Read(missing, read, id => available.GetValueOrDefault(id)));
        Equal(available[TestMaterial], MaterialRules.Read(TestMaterial, read, id => available.GetValueOrDefault(id)));
        Check(read.Contains(missing), "Find 실패 참조 id가 사라짐");
        references.Set(top, read);
        references.Set(other, new[] { replacement });
        available[missing] = MaterialDescriptor.Create(1, new(1, 0, 0));
        var update = MaterialRules.EventImpact(null, available[missing], MaterialEvent.Added, true);
        Equal(MaterialUpdate.Dirty, update);
        var dirty = update == MaterialUpdate.Dirty
            ? references.Affected(new HashSet<Guid> { missing }) : Array.Empty<Guid>();
        Check(dirty.SequenceEqual(new[] { top }), "실패했던 참조의 Added가 해당 객체를 찾지 못함");
        Check(references.Affected(new HashSet<Guid> { TestMaterial }).SequenceEqual(new[] { top }));
        Check(references.Affected(new HashSet<Guid> { missing, replacement }).ToHashSet().SetEquals(new[] { top, other }));
        references.Set(top, new[] { replacement });
        Equal(0, references.Affected(new HashSet<Guid> { missing }).Length);
        references.Remove(other);
        Check(references.Affected(new HashSet<Guid> { replacement }).SequenceEqual(new[] { top }));
        references.Clear();
        Equal(0, references.Affected(new HashSet<Guid> { replacement }).Length);

        var table = TestMaterials();
        table[Guid.NewGuid()] = MaterialDescriptor.Create(1, new(1, 1, 1),
            colorMap: new(MaterialRules.TextureId(new byte[] { 0xFF, 0xD8, 0xFF }), RhinoRepeatOffset));
        table[Guid.NewGuid()] = table[TexturedMaterial];
        Equal(0, references.Textures(table).Length);
        references.Set(top, new[] { TexturedMaterial, TestMaterial });
        references.Set(other, new[] { TexturedMaterial });
        Check(references.Textures(table).SequenceEqual(new[] { TestTextureId }), "참조하지 않는 재질의 텍스처를 실음");
    }

    private static void MaterialEvents()
    {
        var general = MaterialDescriptor.Create(1, new(0.2, 0.3, 0.4));
        var changed = MaterialDescriptor.Create(1, new(0.7, 0.3, 0.4));
        var gem = TestMaterials()[TestMaterial];
        var textured = MaterialDescriptor.Create(1, general.Color, colorMap: new(TestTextureId, RhinoRepeatOffset));
        var cases = new List<(string Name, MaterialDescriptor? Before, MaterialDescriptor? After,
            MaterialEvent Event, bool TopLevel, bool Ignore, MaterialUpdate Expected)>
        {
            ("없는 값 동일", null, null, MaterialEvent.Changed, true, false, MaterialUpdate.Ignore),
            ("새 기술자지만 값 동일", general, general with { }, MaterialEvent.Changed, true, false, MaterialUpdate.Ignore),
            ("값만 변경", general, changed, MaterialEvent.Changed, true, false, MaterialUpdate.Metadata),
            ("kind 변경", general, gem, MaterialEvent.Changed, true, false, MaterialUpdate.Dirty),
            ("재질 해석 복구", null, general, MaterialEvent.Changed, true, false, MaterialUpdate.Dirty),
            ("재질 해석 실패", general, null, MaterialEvent.Changed, true, false, MaterialUpdate.Dirty),
            ("텍스처 교체", textured, MaterialDescriptor.Create(1, general.Color,
                colorMap: new(MaterialRules.TextureId(new byte[] { 0xFF, 0xD8, 0xFF }), RhinoRepeatOffset)),
                MaterialEvent.Changed, false, false, MaterialUpdate.Metadata),
            ("텍스처 반복·오프셋 변경", textured, MaterialDescriptor.Create(1, general.Color,
                colorMap: new(TestTextureId, new(1, 0, 0, 0, 1, 0))), MaterialEvent.Changed, false, false, MaterialUpdate.Metadata),
            ("같은 텍스처 다시 읽음", textured, MaterialDescriptor.Create(1, general.Color,
                colorMap: new(MaterialRules.TextureId(TestTexture.ToArray()), RhinoRepeatOffset)),
                MaterialEvent.Changed, false, false, MaterialUpdate.Ignore),
            ("텍스처 제거", textured, general, MaterialEvent.Changed, false, false, MaterialUpdate.Metadata)
        };
        foreach (var change in new[] { MaterialEvent.Added, MaterialEvent.Deleted, MaterialEvent.Replaced })
        {
            cases.Add(($"최상위 {change} 값 동일", general, general with { }, change, true, false, MaterialUpdate.Dirty));
            cases.Add(($"최상위 {change} 해석 실패", null, null, change, true, false, MaterialUpdate.Dirty));
            cases.Add(($"하위 {change} 값 동일", general, general with { }, change, false, false, MaterialUpdate.Ignore));
            cases.Add(($"하위 {change} 값 변경", general, changed, change, false, false, MaterialUpdate.Metadata));
            cases.Add(($"하위 {change} 부모 kind 변경", general, gem, change, false, false, MaterialUpdate.Dirty));
        }
        foreach (var change in Enum.GetValues<MaterialEvent>())
        {
            foreach (var topLevel in new[] { true, false })
                cases.Add(($"Ignore {change} 최상위={topLevel}", general, gem, change, topLevel, true, MaterialUpdate.Ignore));
        }
        foreach (var item in cases)
            Check(item.Expected == MaterialRules.EventImpact(item.Before, item.After, item.Event, item.TopLevel, item.Ignore),
                "이벤트 판정: " + item.Name);

        foreach (var value in new[]
        {
            changed,
            MaterialDescriptor.Create(1, general.Color, metallic: 0.6),
            MaterialDescriptor.Create(1, general.Color, roughness: 0.6),
            MaterialDescriptor.Create(1, general.Color, ior: 1.6),
            MaterialDescriptor.Create(1, general.Color, opacity: 0.6),
            MaterialDescriptor.Create(1, general.Color, clearcoat: 0.6),
            MaterialDescriptor.Create(1, general.Color, clearcoatRoughness: 0.6)
        })
        {
            Equal(MaterialUpdate.Metadata, MaterialRules.EventImpact(general, value, MaterialEvent.Changed, true));
            // 시뮬레이션이 나중에 같은 값으로 알리는 이벤트는 더 발행하지 않는다.
            Equal(MaterialUpdate.Ignore, MaterialRules.EventImpact(value, value with { }, MaterialEvent.Changed, true));
        }
    }

    private static void MaterialValues()
    {
        Equal((byte)2, MaterialRules.Kind(MaterialRules.GemType));
        foreach (var type in new[] { "037469d6-0b9a-4e5f-af10-e483c992993a",
            "51b4af08-9dec-4744-86f9-546fbacb800d", "5a8d7b9b-cdc9-49de-8c16-2ef64fb097ab" })
            Equal((byte)1, MaterialRules.Kind(new Guid(type)));
        var gem = TestMaterials()[TestMaterial];
        var general = MaterialDescriptor.Create(1, new(1, 0, 0));
        Check(!MaterialRules.KindChanged(gem, gem with { }));
        Check(MaterialRules.KindChanged(gem, general));
        Check(MaterialRules.KindChanged(null, gem));
        Check(MaterialRules.KindChanged(general, null));
        Check(!MaterialRules.KindChanged(null, null));
        var invalid = MaterialDescriptor.Create(1, new(double.NaN, -3, 2), double.PositiveInfinity,
            -1, 0, 2, double.NaN, double.NegativeInfinity);
        Equal(new Vec3(1, 0, 1), invalid.Color);
        Equal(0d, invalid.Metallic);
        Equal(0d, invalid.Roughness);
        Equal(1d, invalid.Ior);
        Equal(1d, invalid.Opacity);
        Equal(0d, invalid.Clearcoat);
        Equal(0d, invalid.ClearcoatRoughness);
        Equal<ColorMap?>(null, MaterialDescriptor.Create(1, general.Color,
            colorMap: new(TestTextureId, RhinoRepeatOffset with { M03 = double.NaN })).ColorMap);
        Equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", MaterialRules.TextureId("abc"u8.ToArray()));
        foreach (var (name, header, browser) in new (string, byte[], bool)[]
        {
            ("PNG", TestTexture, true),
            ("JPEG", new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }, true),
            ("GIF", "GIF89a"u8.ToArray(), true),
            ("BMP", "BM\0\0"u8.ToArray(), true),
            ("WebP", "RIFF\0\0\0\0WEBPVP8 "u8.ToArray(), true),
            ("TIFF", new byte[] { 0x49, 0x49, 0x2A, 0x00 }, false),
            ("RIFF WAVE", "RIFF\0\0\0\0WAVEfmt "u8.ToArray(), false),
            ("빈 파일", Array.Empty<byte>(), false)
        })
            Check(browser == MaterialRules.BrowserImage(header), "브라우저 이미지 판정: " + name);
        using var json = JsonDocument.Parse(SceneJson.Manifest(1, new(new(0, 0, 0), 1),
            new("#fff", null, TestMaterials(), TestTextures()), Array.Empty<SceneObject>()));
        var material = json.RootElement.GetProperty("materials").GetProperty(TestMaterial.ToString("D"));
        Check(material.EnumerateObject().Select(property => property.Name).ToHashSet().SetEquals(new[]
            { "kind", "color", "metallic", "roughness", "ior", "opacity", "clearcoat", "clearcoatRoughness", "colorMap" }));
        Equal(JsonValueKind.Null, material.GetProperty("colorMap").ValueKind);
        var colorMap = json.RootElement.GetProperty("materials").GetProperty(TexturedMaterial.ToString("D")).GetProperty("colorMap");
        Equal(TestTextureId, colorMap.GetProperty("texture").GetString());
        Check(colorMap.GetProperty("transform").EnumerateArray().Select(value => value.GetDouble())
            .SequenceEqual(new[] { 2, 0, -0.2, 0, 3, -0.6 }));
        Equal(2, material.GetProperty("kind").GetInt32());
        Check(material.GetProperty("color").EnumerateArray().Select(value => value.GetDouble())
            .SequenceEqual(new[] { 0.878, 0.067, 0.373 }));
        Equal(0d, material.GetProperty("metallic").GetDouble());
        Equal(0.5, material.GetProperty("roughness").GetDouble());
        Equal(1.76, material.GetProperty("ior").GetDouble());
        Equal(0d, material.GetProperty("opacity").GetDouble());
        Equal(0d, material.GetProperty("clearcoat").GetDouble());
        Equal(0d, material.GetProperty("clearcoatRoughness").GetDouble());
    }

    private static void MaterialMetadata()
    {
        var fake = new Fake();
        var id = Guid.NewGuid();
        fake.Objects[id] = Built();
        fake.Materials = TestMaterials();
        var ui = new Dispatcher();
        var store = new MemoryLiveStore();
        var engine = new IncrementalScene(fake, ui, store);
        engine.Reset(new[] { id });
        engine.Start();
        ui.Until(() => !engine.Running);
        var revision = Revisions(store)[id];
        var calls = fake.Calls;
        using var before = JsonDocument.Parse(Get(store));
        Equal(0.878, before.RootElement.GetProperty("materials").GetProperty(TestMaterial.ToString("D"))
            .GetProperty("color")[0].GetDouble());
        var added = Guid.NewGuid();
        fake.Materials = new()
        {
            [TestMaterial] = MaterialDescriptor.Create(2, new(0, 0, 1), ior: 1.76, opacity: 0),
            [added] = MaterialDescriptor.Create(1, new(0, 1, 0))
        };
        engine.MetadataDirty();
        engine.Start();
        ui.Until(() => !engine.Running);
        Equal(calls, fake.Calls);
        Equal(revision, Revisions(store)[id]);
        using var after = JsonDocument.Parse(Get(store));
        Check(after.RootElement.GetProperty("version").GetInt64() > before.RootElement.GetProperty("version").GetInt64());
        var table = after.RootElement.GetProperty("materials");
        Equal(2, table.EnumerateObject().Count());
        Check(table.GetProperty(TestMaterial.ToString("D")).GetProperty("color").EnumerateArray()
            .Select(value => value.GetDouble()).SequenceEqual(new[] { 0d, 0d, 1d }));
        Equal(1.76, table.GetProperty(TestMaterial.ToString("D")).GetProperty("ior").GetDouble());
        Equal(1, table.GetProperty(added.ToString("D")).GetProperty("kind").GetInt32());
        Equal(1d, table.GetProperty(added.ToString("D")).GetProperty("color")[1].GetDouble());
    }

    private static void WebProtocol()
    {
        var payload = Path.Combine(Temp, "material.rvm");
        var manifest = Path.Combine(Temp, "material.json");
        var small = Small(smooth: true);
        File.WriteAllBytes(payload, MeshPayload.Write(small));
        File.WriteAllBytes(manifest, SceneJson.Manifest(1, new(new(0, 0, 0), 1),
            new("#fff", null, TestMaterials(), TestTextures()), Array.Empty<SceneObject>()));
        using (var export = File.Create(Path.Combine(Temp, "material.rvs")))
            SceneExport.WriteRvs(export,
                new[] { new SceneObject(Object().Id, 1, MeshPayload.Write(small), MeshPayloadReader.Bounds(small)) },
                new(new(0, 0, 0), 1),
                new("#fff", null, TestMaterials(), TestTextures()));
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = Root, RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add(Path.Combine(Root, "tools", "test-scene-materials.mjs"));
        start.ArgumentList.Add(payload);
        start.ArgumentList.Add(manifest);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        Check(process.ExitCode == 0, stdout.Result + stderr.Result);
    }

    private static void StoneTag()
    {
        foreach (var (name, kind, pathTags, smooth) in new (string, byte, string?[], bool)[]
        {
            ("태그 없음", 2, new string?[] { null }, false),
            ("빈 값", 2, new string?[] { "" }, false),
            ("1", 2, new string?[] { "1" }, true),
            ("true", 2, new string?[] { "true" }, true),
            ("yes", 2, new string?[] { "yes" }, true),
            ("대소문자 무시", 2, new string?[] { "TRUE" }, true),
            ("앞뒤 공백", 2, new string?[] { " 1 " }, true),
            ("0", 2, new string?[] { "0" }, false),
            ("2", 2, new string?[] { "2" }, false),
            ("참값으로 시작하는 다른 값", 2, new string?[] { "truthy" }, false),
            ("금속에 태그", 0, new string?[] { "1" }, false),
            ("일반 재질에 태그", 1, new string?[] { "1" }, false),
            ("블록 인스턴스에만", 2, new string?[] { "1", null }, true),
            ("블록 정의 자식에만", 2, new string?[] { null, "1" }, true),
            ("블록 둘 다", 2, new string?[] { "1", "1" }, true),
            ("블록 인스턴스 0 + 정의 자식 1", 2, new string?[] { "0", "1" }, true),
            ("중첩 블록 바깥 인스턴스에만", 2, new string?[] { "1", null, null }, true),
            ("블록 태그 없음", 2, new string?[] { null, null }, false)
        })
        {
            Check(StoneRules.Smooth(kind, pathTags) == smooth, name);
        }
    }
}
