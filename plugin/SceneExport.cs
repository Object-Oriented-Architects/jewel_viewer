using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace JewelViewer;

internal static class SceneExport
{
    public static void WriteRvs(
        Stream output, IReadOnlyList<SceneObject> objects, SceneFrame frame, Presentation presentation)
    {
        long offset = 0;
        object Block(string id, byte[] payload)
        {
            var entry = new { id, offset, length = payload.LongLength };
            offset = checked(offset + payload.LongLength);
            return entry;
        }
        var textures = presentation.Textures.ToArray();
        var entries = objects.Select(obj => Block(obj.Id.ToString("D"), obj.Payload)).ToArray();
        var textureEntries = textures.Select(pair => Block(pair.Key, pair.Value)).ToArray();
        var header = JsonSerializer.SerializeToUtf8Bytes(new
        {
            center = frame.Center.Array,
            scale = frame.Scale,
            background = presentation.Background,
            camera = SceneJson.Camera(presentation.Camera),
            materials = SceneJson.Materials(presentation),
            objects = entries,
            textures = textureEntries
        });

        using var writer = new BinaryWriter(output, Encoding.UTF8, true);
        writer.Write(Encoding.ASCII.GetBytes("RVS1"));
        writer.Write((uint)header.Length);
        writer.Write(header);
        for (int index = 0; index < (4 - (header.Length + 8) % 4) % 4; index++)
            writer.Write((byte)0);
        foreach (var obj in objects)
            output.Write(obj.Payload);
        foreach (var (_, image) in textures)
            output.Write(image);
    }

    // 작은 셸만 메모리에 읽는다. 컨테이너·base64 문자열·완성 HTML 사본은 만들지 않는다.
    public static void WriteHtml(
        Stream output, string shell, IReadOnlyList<SceneObject> objects, SceneFrame frame, Presentation presentation)
    {
        var end = shell.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (end < 0)
            throw new InvalidDataException("내보내기 셸에 </head>가 없습니다.");

        WriteText(output, shell[..end]);
        WriteText(output, "<script>window.__SCENE_RVS=\"");
        using (var transform = new ToBase64Transform())
        using (var base64 = new CryptoStream(output, transform, CryptoStreamMode.Write, true))
        {
            WriteRvs(base64, objects, frame, presentation);
            base64.FlushFinalBlock();
        }
        WriteText(output, "\";</script>");
        WriteText(output, shell[end..]);
    }

    private static void WriteText(Stream output, string value)
    {
        using var writer = new StreamWriter(output, new UTF8Encoding(false), 65536, true);
        writer.Write(value);
    }
}
