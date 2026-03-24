"""
Replace remaining Shape nodes with Constant nodes using shape inference.
Run AFTER onnxsim to fix the leftover Shape ops in FourierUnit blocks.
"""
import onnx
import numpy as np
from onnx import numpy_helper, TensorProto, helper, shape_inference
from collections import defaultdict

SRC = "public/models/lama_fp32_int32.onnx"
DST = "public/models/lama_fp32_int32.onnx"  # overwrite

model = onnx.load(SRC)

# Run shape inference to populate all tensor shapes
print("Running shape inference...")
model = shape_inference.infer_shapes(model)
graph = model.graph

# Build shape map from value_info + inputs
shape_map = {}
for vi in list(graph.value_info) + list(graph.input) + list(graph.output):
    tt = vi.type.tensor_type
    if tt.HasField('shape'):
        dims = []
        for d in tt.shape.dim:
            if d.dim_value > 0:
                dims.append(d.dim_value)
            else:
                dims.append(-1)  # dynamic
        shape_map[vi.name] = dims

# Find all Shape nodes and try to replace with constants
shape_nodes = [n for n in graph.node if n.op_type == "Shape"]
print(f"Shape nodes to replace: {len(shape_nodes)}")

replaced = 0
nodes_to_remove = []
nodes_to_add = []

for node in shape_nodes:
    input_name = node.input[0]
    output_name = node.output[0]

    shape = shape_map.get(input_name)
    if shape is None or -1 in shape:
        print(f"  SKIP {node.name}: input {input_name} has unknown shape {shape}")
        continue

    # Create a Constant node with the shape values as int32
    shape_arr = np.array(shape, dtype=np.int32)
    const_tensor = numpy_helper.from_array(shape_arr)

    const_node = helper.make_node(
        "Constant",
        inputs=[],
        outputs=[output_name],
        name=f"const_shape_{output_name}",
        value=const_tensor,
    )

    nodes_to_remove.append(node)
    nodes_to_add.append(const_node)
    replaced += 1

# Remove old Shape nodes and add new Constant nodes
for node in nodes_to_remove:
    graph.node.remove(node)
for node in nodes_to_add:
    graph.node.append(node)

# Convert all remaining int64 value_info
for vi in graph.value_info:
    if vi.type.tensor_type.elem_type == TensorProto.INT64:
        vi.type.tensor_type.elem_type = TensorProto.INT32

# Final verification
remaining_shapes = sum(1 for n in graph.node if n.op_type == "Shape")
remaining_int64_vi = sum(1 for vi in graph.value_info
                         if vi.type.tensor_type.elem_type == TensorProto.INT64)

print(f"Replaced {replaced} Shape nodes with Constants")
print(f"Remaining Shape nodes: {remaining_shapes}")
print(f"Remaining int64 value_info: {remaining_int64_vi}")

onnx.save(model, DST)
import os
print(f"Saved: {DST} ({os.path.getsize(DST) / 1024 / 1024:.1f} MB)")
