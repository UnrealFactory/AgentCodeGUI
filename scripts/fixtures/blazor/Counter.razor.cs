namespace BlazorProbe;

public partial class Counter
{
    /// <summary>The title shown by the counter component.</summary>
    protected string Title => "Counter";
    protected int Count { get; set; }
    protected void Increment() => Count++;
}
