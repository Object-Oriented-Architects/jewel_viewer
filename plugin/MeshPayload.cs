using System.IO.Compression;
using System.Text;

namespace JewelViewer;

internal sealed record MeshPart(
    byte Kind, Guid MaterialId, float[] Positions, float[] Normals, float[]? Uvs, uint[] Indices, bool Smooth);

internal sealed record MeshObject(Vec3 Origin, IReadOnlyList<MeshPart> Parts);

/// <summary>C6: 원점은 double, 상대 정점·단위 노멀·UV는 float, 인덱스는 u32로 기록한다. flags bit0 = UV, bit1 = 둥근 스톤.</summary>
internal static class MeshPayload
{
    public static byte[] Write(MeshObject obj)
    {
        using var output = new MemoryStream();
        using (var zip = new GZipStream(output, CompressionLevel.Fastest, true))
        using (var writer = new BinaryWriter(zip, Encoding.UTF8, true))
        {
            writer.Write(Encoding.ASCII.GetBytes("RVM3"));
            var parts = obj.Parts.Where(part => part.Positions.Length > 0).ToArray();
            writer.Write((uint)parts.Length);
            writer.Write(obj.Origin.X);
            writer.Write(obj.Origin.Y);
            writer.Write(obj.Origin.Z);

            foreach (var part in parts)
            {
                if (part.Kind > 2 || part.Positions.Length % 3 != 0 ||
                    part.Normals.Length != part.Positions.Length ||
                    (part.Uvs != null && part.Uvs.Length != part.Positions.Length / 3 * 2) ||
                    part.Indices.Length % 3 != 0 ||
                    part.Indices.Any(index => index >= part.Positions.Length / 3))
                {
                    throw new InvalidDataException("RVM3 메시 파트가 올바르지 않습니다.");
                }

                writer.Write(part.Kind);
                writer.Write((byte)((part.Uvs == null ? 0 : 1) | (part.Smooth ? 2 : 0)));
                writer.Write(new byte[2]);
                writer.Write(part.MaterialId.ToByteArray());
                writer.Write((uint)(part.Positions.Length / 3));
                writer.Write((uint)part.Indices.Length);
                foreach (var value in part.Positions)
                    writer.Write(value);
                foreach (var value in part.Normals)
                    writer.Write(value);
                foreach (var value in part.Uvs ?? Array.Empty<float>())
                    writer.Write(value);
                foreach (var index in part.Indices)
                    writer.Write(index);
            }
        }
        return output.ToArray();
    }
}
