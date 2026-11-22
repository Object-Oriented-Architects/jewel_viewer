using System.IO.Compression;
using System.Text;

namespace JewelViewer;

/// <summary>시험·통합 하네스 전용 C6 디코더. 플러그인 어셈블리에는 포함하지 않는다.</summary>
internal static class MeshPayloadReader
{
    public static MeshObject Read(byte[] payload)
    {
        using var input = new MemoryStream(payload, false);
        using var zip = new GZipStream(input, CompressionMode.Decompress);
        using var reader = new BinaryReader(zip);
        if (Encoding.ASCII.GetString(reader.ReadBytes(4)) != "RVM3")
        {
            throw new InvalidDataException("RVM3 매직이 올바르지 않습니다.");
        }

        var count = reader.ReadUInt32();
        var origin = new Vec3(reader.ReadDouble(), reader.ReadDouble(), reader.ReadDouble());
        var parts = new List<MeshPart>();
        for (uint part = 0; part < count; part++)
        {
            var kind = reader.ReadByte();
            var flags = reader.ReadByte();
            var reserved = reader.ReadBytes(2);
            var materialId = new Guid(reader.ReadBytes(16));
            var vertexCount = checked((int)reader.ReadUInt32());
            var indexCount = checked((int)reader.ReadUInt32());
            if (kind > 2 || flags > 3 || reserved.Length != 2 || reserved.Any(value => value != 0) ||
                vertexCount <= 0 || indexCount % 3 != 0)
            {
                throw new InvalidDataException("RVM3 파트 헤더가 올바르지 않습니다.");
            }

            var positions = new float[checked(vertexCount * 3)];
            var normals = new float[positions.Length];
            var uvs = (flags & 1) != 0 ? new float[checked(vertexCount * 2)] : null;
            var indices = new uint[indexCount];
            for (int index = 0; index < positions.Length; index++)
            {
                positions[index] = reader.ReadSingle();
            }
            for (int index = 0; index < normals.Length; index++)
            {
                normals[index] = reader.ReadSingle();
            }
            for (int index = 0; index < (uvs?.Length ?? 0); index++)
            {
                uvs![index] = reader.ReadSingle();
            }
            for (int index = 0; index < indices.Length; index++)
            {
                indices[index] = reader.ReadUInt32();
                if (indices[index] >= vertexCount)
                {
                    throw new InvalidDataException("RVM3 인덱스가 정점 범위를 벗어났습니다.");
                }
            }
            parts.Add(new(kind, materialId, positions, normals, uvs, indices, (flags & 2) != 0));
        }
        if (reader.BaseStream.ReadByte() != -1)
        {
            throw new InvalidDataException("RVM3 뒤에 불필요한 바이트가 있습니다.");
        }
        return new(origin, parts);
    }

    public static WorldBox Bounds(MeshObject obj)
    {
        WorldBox? box = null;
        foreach (var part in obj.Parts)
        {
            for (int index = 0; index < part.Positions.Length; index += 3)
            {
                var vertex = new Vec3(obj.Origin.X + part.Positions[index],
                    obj.Origin.Y + part.Positions[index + 1], obj.Origin.Z + part.Positions[index + 2]);
                var pointBox = new WorldBox(vertex, vertex);
                box = box?.Union(pointBox) ?? pointBox;
            }
        }
        return box ?? new(new(0, 0, 0), new(0, 0, 0));
    }
}
