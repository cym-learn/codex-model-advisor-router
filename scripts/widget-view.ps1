function Get-WidgetView($snapshot, [string]$lockedRoot) {
    if ($snapshot.schemaVersion -ne 2) { throw 'Unsupported status schema' }
    $eligible = @($snapshot.conversations | Where-Object {
        $_.rootThreadId -and $_.displayName -and ($_.turns | Where-Object { $_.taskRole -eq 'main' -and -not $_.isAuxiliary })
    })
    if ($lockedRoot) { $selected = $eligible | Where-Object { $_.rootThreadId -eq $lockedRoot } | Select-Object -First 1 }
    else { $selected = $eligible | Where-Object { $_.sourceKind -eq 'desktop' } | Sort-Object { ($_.turns | Where-Object { -not $_.isAuxiliary } | Sort-Object latestAt -Descending | Select-Object -First 1).latestAt } -Descending | Select-Object -First 1 }
    if (-not $selected) {
        return @{ Name='没有可识别的主对话'; Role='等待请求'; Pair='模型／强度未知'; Status=$(if ($lockedRoot) {'锁定对话暂不可见'} else {'测试、CLI 和未知来源不会自动跟随'}); Roots=$eligible; Root=$null }
    }
    $turn = $selected.turns | Where-Object { $_.taskRole -eq 'main' -and -not $_.isAuxiliary } | Sort-Object latestAt -Descending | Select-Object -First 1
    $active = $selected.turns | Where-Object { -not $_.isAuxiliary -and ($_.requests | Where-Object { $_.runId -eq $snapshot.runId -and $_.state -in @('pending','executing') }) } | Sort-Object latestAt -Descending | Select-Object -First 1
    if ($active) { $turn = $active }
    $request = $turn.requests | Select-Object -Last 1
    $role = if ($turn.taskRole -eq 'child') { '子任务' } else { '主任务' }
    if ($turn.finalReply.status -eq 'confirmed' -and -not $active) {
        $pair = $turn.finalReply.pair
        $status = if ($turn.taskRole -eq 'child') { '子任务结果完成确认' } else { '最终回复完成确认' }
    } elseif ($request.reported.model -or $request.reported.effort) {
        $pair = $request.reported
        $status = if ($request.state -in @('pending','executing')) { '服务端报告 · 执行中' }
            elseif ($request.verification -eq 'confirmed') { '调用完成确认 · 回复归属未证实' } else { '服务端报告 · 未证实' }
    } else { $pair = $request.planned; $status = '拟选配置 · 未证实' }
    if (-not $active -and $turn.finalReply.evidence -eq 'native_final_item_missing' -and $request.verification -eq 'confirmed') { $status = '调用完成 · 等待本机记录／未证实' }
    if ($request.reason -eq 'same_turn_route_missing') { $status = '同轮选择未恢复 · 连续性未证实' }
    if ($request.state -eq 'cancelled') { $status = '已取消 · 未完成' }
    elseif ($request.state -in @('failed','error','interrupted')) { $status = '失败／中断 · 未证实' }
    elseif ($request.verification -eq 'mismatch') { $status = '配置不匹配 · 未证实' }
    $model = if ($pair.model) { $pair.model -replace '^gpt-6-', 'GPT-6 ' } else { '未知模型' }
    $effort = if ($pair.effort) { $pair.effort } else { '未知强度' }
    $jev = $turn.jev
    $hint = ''
    if ($jev.suggested) { $hint = "Jev 建议 $($jev.suggested.model -replace '^gpt-6-','')/$($jev.suggested.effort) · 未执行" }
    elseif ($jev.status -eq 'pending') { $hint = 'Jev 后台判断中 · 未执行' }
    elseif ($jev) { $hint = 'Jev 无建议 · ' + $jev.reason }
    if ($turn.selection) {
        if ($turn.selection.source -eq 'jev') { $hint = 'Jev 自动选型 · 实际执行见上方确认' }
        elseif ($turn.selection.jev.suggested) { $hint = 'Jev 建议 ' + $turn.selection.jev.suggested.model + '/' + $turn.selection.jev.suggested.effort + ' · 未执行' }
        elseif ($turn.selection.source -eq 'incoming') { $hint = '保留用户原配置 · ' + $turn.selection.reason }
        else { $hint = '规则 · ' + $turn.selection.reason }
    }
    $experiment = $turn.experiment
    if ($experiment) {
        if ($experiment.applied) { $hint = 'Jev 配置已用于试验请求 · 执行见上方状态' }
        elseif ($experiment.fallback) { $hint = '试验退回／保护 · ' + $experiment.fallback }
        else { $hint = '规则／固定配置试验 · 日常规则不变' }
    }
    return @{ Name=$selected.displayName; Role=$role; Pair="$model / $effort"; Status=$status; Jev=$hint; Roots=$eligible; Root=$selected.rootThreadId }
}
