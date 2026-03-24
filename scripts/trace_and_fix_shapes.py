"""
Full pipeline: onnxsim → trace Shape values → replace Shapes → convert int64.

Starts from the ORIGINAL lama_fp32.onnx (with proper int64 types) so that
onnxruntime can load and run it for tracing. Then does all conversions at the end.
"""
import onnx
import numpy as np
import onnxruntime as onnxrt
import onnxsim
from onnx import numpy_helper, TensorProto, helper
import copy
import os

SRC = "public/models/lama_fp32.onnx"
DST = "public/models/lama_fp32_int32.onnx"

# --- Step 1: Simplify with onnxsim ---
print("Loading original model...")
model = onnx.load(SRC)

int64_ops_before = sum(1 for n in model.graph.node if n.op_type == "Shape")
print(f"Shape ops before simplification: {int64_ops_before}")

print("Running onnx-simplifier...")
model, check = onnxsim.simplify(
    model,
    input_shapes={
        "image": [1, 3, 512, 512],
        "mask": [1, 1, 512, 512],
    },
)
assert check, "Simplified model validation failed!"

shape_nodes = [n for n in model.graph.node if n.op_type == "Shape"]
print(f"Shape ops after simplification: {len(shape_nodes)} (was {int64_ops_before})")

if len(shape_nodes) == 0:
    print("All Shape nodes folded! Skipping trace step.")
else:
    # --- Step 2: Trace to get concrete Shape values ---
    print(f"\nTracing {len(shape_nodes)} remaining Shape nodes...")

    # Save simplified (but still int64-valid) model for tracing
    TRACE_PATH = "public/models/_trace_temp.onnx"

    trace_model = copy.deepcopy(model)
    trace_graph = trace_model.graph

    shape_output_names = []
    for node in trace_graph.node:
        if node.op_type == "Shape":
            shape_output_names.append(node.output[0])

    # Add Shape outputs as graph outputs
    for name in shape_output_names:
        out = helper.make_tensor_value_info(name, TensorProto.INT64, None)
        trace_graph.output.append(out)

    onnx.save(trace_model, TRACE_PATH)
    del trace_model

    # Run inference with dummy input
    print("Running inference to capture Shape values...")
    sess = onnxrt.InferenceSession(TRACE_PATH, providers=["CPUExecutionProvider"])

    dummy_image = np.random.randn(1, 3, 512, 512).astype(np.float32)
    dummy_mask = np.zeros((1, 1, 512, 512), dtype=np.float32)

    all_output_names = [o.name for o in sess.get_outputs()]
    results = sess.run(all_output_names, {
        sess.get_inputs()[0].name: dummy_image,
        sess.get_inputs()[1].name: dummy_mask,
    })

    output_map = {}
    for name, val in zip(all_output_names, results):
        if name in shape_output_names:
            output_map[name] = val

    print(f"Captured {len(output_map)} Shape output values")

    del sess
    os.remove(TRACE_PATH)

    # --- Step 3: Replace Shape nodes with Constants ---
    print("Replacing Shape nodes with Constants...")
    graph = model.graph
    nodes_to_remove = []
    nodes_to_add = []

    for node in graph.node:
        if node.op_type != "Shape":
            continue
        output_name = node.output[0]
        if output_name not in output_map:
            print(f"  WARNING: no trace value for {output_name}, skipping")
            continue

        # Keep as int64 for now (will convert to int32 in next step)
        concrete_val = output_map[output_name]
        print(f"  {node.name}: {concrete_val.flatten().tolist()}")
        const_tensor = numpy_helper.from_array(concrete_val)

        const_node = helper.make_node(
            "Constant",
            inputs=[],
            outputs=[output_name],
            name=f"const_shape_{output_name}",
            value=const_tensor,
        )

        nodes_to_remove.append(node)
        nodes_to_add.append(const_node)

    for node in nodes_to_remove:
        graph.node.remove(node)
    for node in nodes_to_add:
        graph.node.append(node)

    print(f"Replaced {len(nodes_to_remove)} Shape nodes")

# --- Step 4: Convert ALL int64 to int32 ---
print("\nConverting int64 → int32...")
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

print(f"Int64 fixes applied: {fixes}")

# --- Step 5: Final verification ---
remaining_shapes = sum(1 for n in graph.node if n.op_type == "Shape")
remaining_size = sum(1 for n in graph.node if n.op_type == "Size")
remaining_int64_cast = sum(1 for n in graph.node if n.op_type == "Cast"
                           for a in n.attribute if a.name == "to" and a.i == TensorProto.INT64)
remaining_int64_vi = sum(1 for vi in graph.value_info
                          if vi.type.tensor_type.elem_type == TensorProto.INT64)
remaining_int64_init = sum(1 for init in graph.initializer
                            if init.data_type == TensorProto.INT64)
remaining_int64_const = 0
for n in graph.node:
    if n.op_type == "Constant":
        for a in n.attribute:
            if a.name == "t" and a.t.data_type == TensorProto.INT64:
                remaining_int64_const += 1

print(f"\n=== Final Status ===")
print(f"Shape nodes: {remaining_shapes}")
print(f"Size nodes: {remaining_size}")
print(f"Cast-to-int64: {remaining_int64_cast}")
print(f"Int64 value_info: {remaining_int64_vi}")
print(f"Int64 initializers: {remaining_int64_init}")
print(f"Int64 Constant nodes: {remaining_int64_const}")
print(f"Total nodes: {len(graph.node)}")

onnx.save(model, DST)
print(f"\nSaved: {DST} ({os.path.getsize(DST) / 1024 / 1024:.1f} MB)")
