"""
Convert LaMa ONNX model for WebGL: eliminate all int64 by constant-folding.

The WebGL EP rejects Shape/Size/Gather ops because they produce int64 outputs
per ONNX spec. Solution: use onnx-simplifier to fold these into constants
(since input shape is fixed at 512x512), then convert any remaining int64.
"""
import onnx
import numpy as np
from onnx import numpy_helper, TensorProto, helper
import onnxsim

SRC = "public/models/lama_fp32.onnx"
DST = "public/models/lama_fp32_int32.onnx"

print("Loading model...")
model = onnx.load(SRC)

# Count int64-producing ops before
int64_ops_before = sum(1 for n in model.graph.node if n.op_type in ("Shape", "Size", "NonZero"))
print(f"Shape/Size/NonZero ops before simplification: {int64_ops_before}")

# Simplify: constant-fold with fixed input shapes
print("Running onnx-simplifier (this folds Shape ops into constants)...")
model, check = onnxsim.simplify(
    model,
    input_shapes={
        "image": [1, 3, 512, 512],
        "mask": [1, 1, 512, 512],
    },
)
assert check, "Simplified model validation failed!"

int64_ops_after = sum(1 for n in model.graph.node if n.op_type in ("Shape", "Size", "NonZero"))
print(f"Shape/Size/NonZero ops after simplification: {int64_ops_after} (was {int64_ops_before})")

# Now convert ANY remaining int64 (initializers, constants, casts, value_info)
graph = model.graph
fixes = 0

for init in graph.initializer:
    if init.data_type == TensorProto.INT64:
        arr = numpy_helper.to_array(init).astype(np.int32)
        new_init = numpy_helper.from_array(arr, name=init.name)
        init.CopyFrom(new_init)
        fixes += 1

for node in graph.node:
    if node.op_type == "Constant":
        for attr in node.attribute:
            if attr.name == "t" and attr.t.data_type == TensorProto.INT64:
                arr = numpy_helper.to_array(attr.t).astype(np.int32)
                new_t = numpy_helper.from_array(arr)
                attr.t.CopyFrom(new_t)
                fixes += 1
    if node.op_type == "ConstantOfShape":
        for attr in node.attribute:
            if attr.name == "value" and attr.t.data_type == TensorProto.INT64:
                arr = numpy_helper.to_array(attr.t).astype(np.int32)
                new_t = numpy_helper.from_array(arr)
                attr.t.CopyFrom(new_t)
                fixes += 1
    if node.op_type == "Cast":
        for attr in node.attribute:
            if attr.name == "to" and attr.i == TensorProto.INT64:
                attr.i = TensorProto.INT32
                fixes += 1

for vi in graph.value_info:
    if vi.type.tensor_type.elem_type == TensorProto.INT64:
        vi.type.tensor_type.elem_type = TensorProto.INT32
        fixes += 1

for io_list in [graph.input, graph.output]:
    for io in io_list:
        if io.type.tensor_type.elem_type == TensorProto.INT64:
            io.type.tensor_type.elem_type = TensorProto.INT32
            fixes += 1

print(f"Post-simplification int64 fixes: {fixes}")

# Final check
remaining_int64 = 0
for n in graph.node:
    if n.op_type in ("Shape", "Size", "NonZero"):
        remaining_int64 += 1
        print(f"  WARNING: remaining {n.op_type} node: {n.name}")
    if n.op_type == "Cast":
        for attr in n.attribute:
            if attr.name == "to" and attr.i == TensorProto.INT64:
                remaining_int64 += 1
for vi in graph.value_info:
    if vi.type.tensor_type.elem_type == TensorProto.INT64:
        remaining_int64 += 1
for init in graph.initializer:
    if init.data_type == TensorProto.INT64:
        remaining_int64 += 1

print(f"Remaining int64 references: {remaining_int64}")

onnx.save(model, DST)
import os
print(f"Saved: {DST} ({os.path.getsize(DST) / 1024 / 1024:.1f} MB)")
print(f"Total nodes: {len(graph.node)}")
